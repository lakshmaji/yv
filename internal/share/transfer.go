package share

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"

	"yv/internal/models"
)

// Response bytes the receiver writes after reading an offer.
const (
	respAccept  byte = 0x01
	respDecline byte = 0x00
	respBadPIN  byte = 0x02
	// respDone is written once the payload has been read and applied. The
	// sender waits for it, so "Sent" on screen means the config actually landed
	// rather than merely that the bytes left the building.
	respDone byte = 0x03
	// respNoConn refuses a transfer from a peer that is not connected, which
	// tells the sender to start the connection step again rather than reporting
	// a failure the user cannot act on.
	respNoConn byte = 0x05
	// respNoAnswer means nobody answered — the prompt sat untouched until it expired.
	// Distinct from respDecline because "they said no" and "they were not at
	// their desk" are different things to be told, and the sender's next move
	// differs: one is worth retrying, the other is not.
	respNoAnswer byte = 0x06
)

const (
	// offerTimeout bounds reading the offer header and writing the response.
	offerTimeout = 30 * time.Second

	// decisionTimeout is how long a receiver's prompt may sit unanswered before
	// the sender is released. Without it a sender would hang on a laptop whose
	// owner walked away.
	decisionTimeout = 2 * time.Minute

	// payloadTimeout bounds the gzip stream itself. Config is tens of KB, so
	// this is generous by orders of magnitude.
	payloadTimeout = 60 * time.Second

	// maxPayload caps a decompressed config payload. Config files are small;
	// this exists so a hostile peer cannot make us allocate without bound
	// through the decompressor.
	maxPayload = 16 << 20 // 16 MB

	// maxFilePayload is the same bound for a "files" transfer, which is
	// legitimately larger. It is MaxTotalBytes plus headroom for base64 and the
	// JSON around it, so a transfer the sender was allowed to build is one the
	// receiver will accept.
	maxFilePayload = MaxTotalBytes*2 + (1 << 20)

	// filePayloadTimeout bounds a file stream. Separate from payloadTimeout
	// because tens of megabytes over a slow link is not the same problem as a
	// few kilobytes of config.
	filePayloadTimeout = 10 * time.Minute
)

const (
	// pinFailDelay is the base wait before answering a peer that got the PIN
	// wrong, doubling per consecutive failure up to pinFailMaxDelay.
	//
	// A PIN check is an oracle: it answers "is this right?" with nothing else
	// attached, and a 6-digit PIN is only a million guesses. The throttle is per
	// peer and cleared on success, so the cost falls on whoever is guessing and
	// never on someone who typed it correctly.
	pinFailDelay    = 500 * time.Millisecond
	pinFailMaxDelay = 8 * time.Second
)

// ErrDeclined and ErrBadPIN distinguish the two refusals a sender can get, so
// the UI can say "declined" rather than a generic failure.
var (
	ErrDeclined = errors.New("the other device declined the transfer")
	ErrBadPIN   = errors.New("incorrect code")

	// ErrNotConnected means the connection lapsed between connecting and
	// sending — the sender's move is to connect again, not to report a fault.
	ErrNotConnected = errors.New("not connected to that device")

	// ErrNoAnswer separates an unanswered prompt from a refused one.
	ErrNoAnswer = errors.New("the other device did not answer")

	// ErrOldVersion is a peer that does not speak this share protocol. Reported
	// on its own because no amount of retrying will help.
	ErrOldVersion = errors.New("that device is running an older version of yv")
)

// Send offers a payload to a peer and, if accepted, streams it.
//
// The payload is gzip'd JSON. That is the whole optimisation: project config is
// text and compresses ~70–80%, while the stream is already framed, ordered and
// encrypted by libp2p — so chunking or a binary codec would add moving parts
// without shortening the transfer measurably.
// The peer ID is taken as a string so that libp2p types stay inside this
// package rather than leaking into the Wails-bound facade.
func (n *Node) Send(ctx context.Context, peerID string, offer models.ShareOffer, payload models.SharePayload) error {
	h := n.host
	if h == nil {
		return errors.New("discovery is not running")
	}

	id, err := peer.Decode(peerID)
	if err != nil {
		return fmt.Errorf("bad peer id: %w", err)
	}

	s, err := h.NewStream(ctx, id, ShareProto)
	if err != nil {
		if isUnsupported(err) {
			return ErrOldVersion
		}
		return fmt.Errorf("open stream: %w", err)
	}

	// Reset only on failure. A graceful Close is what flushes the payload and
	// lets the peer read to EOF — resetting unconditionally would discard
	// buffered bytes the receiver has not consumed yet.
	ok := false
	defer func() {
		if ok {
			_ = s.Close()
			return
		}
		_ = s.Reset()
	}()

	if err := s.SetWriteDeadline(time.Now().Add(offerTimeout)); err != nil {
		return err
	}
	if err := json.NewEncoder(s).Encode(offer); err != nil {
		return fmt.Errorf("send offer: %w", err)
	}

	// The receiver is showing a prompt; allow for a human.
	if err := s.SetReadDeadline(time.Now().Add(decisionTimeout)); err != nil {
		return err
	}
	var resp [1]byte
	if _, err := io.ReadFull(s, resp[:]); err != nil {
		return fmt.Errorf("await response: %w", err)
	}

	switch resp[0] {
	case respAccept:
	case respBadPIN:
		// A refusal is a completed exchange, not a broken stream: close it
		// gracefully so the receiver is not left staring at a reset.
		ok = true
		return ErrBadPIN
	case respNoConn:
		ok = true
		return ErrNotConnected
	case respNoAnswer:
		ok = true
		return ErrNoAnswer
	case respDecline:
		ok = true
		return ErrDeclined
	default:
		return fmt.Errorf("unexpected response %#x", resp[0])
	}

	if err := s.SetWriteDeadline(time.Now().Add(payloadTimeout)); err != nil {
		return err
	}
	gz := gzip.NewWriter(s)
	if err := json.NewEncoder(gz).Encode(payload); err != nil {
		return fmt.Errorf("write payload: %w", err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("flush payload: %w", err)
	}

	// CloseWrite signals EOF to the reader's gzip decoder without tearing down
	// the stream, which a Reset would.
	if err := s.CloseWrite(); err != nil {
		return fmt.Errorf("close write: %w", err)
	}

	// Wait for the receiver to confirm it applied the payload. This is what
	// makes a successful return mean "landed" rather than "sent", and it also
	// keeps the stream open until the last byte has been read.
	if err := s.SetReadDeadline(time.Now().Add(payloadTimeout)); err != nil {
		return err
	}
	if _, err := io.ReadFull(s, resp[:]); err != nil {
		return fmt.Errorf("await confirmation: %w", err)
	}
	if resp[0] != respDone {
		return fmt.Errorf("the other device could not apply the config")
	}

	ok = true
	return nil
}

// handleShare serves an inbound stream: either a connection request, or a
// transfer from a peer that has already connected.
func (n *Node) handleShare(s network.Stream) {
	// As in Send: a completed exchange — including a refused one — closes
	// gracefully so the response byte is actually delivered. Only a broken or
	// malformed exchange resets.
	ok := false
	defer func() {
		if ok {
			_ = s.Close()
			return
		}
		_ = s.Reset()
	}()

	remote := s.Conn().RemotePeer()

	_ = s.SetReadDeadline(time.Now().Add(offerTimeout))
	// bufio because the JSON decoder would otherwise read past the header and
	// swallow the first bytes of the gzip stream that follows it.
	br := bufio.NewReader(s)

	var offer models.ShareOffer
	if err := json.NewDecoder(br).Decode(&offer); err != nil {
		return
	}

	// Trust the connection for identity, not the header: FromName is display
	// text from another machine, so fall back to what we already resolved for
	// this peer rather than showing whatever it claims.
	offer.TransferID = newTransferID(remote, offer.TransferID)
	offer.FromName = n.displayName(remote, offer.FromName)
	code := offer.PIN
	offer.PIN = ""

	if offer.Kind == models.OfferKindConnect {
		ok = n.handleConnect(s, remote, offer, code)
		return
	}

	// A transfer from a peer that never connected is refused without a prompt.
	// The connection step is where this device's owner decided to talk to them
	// at all, and skipping it must not be a way around that decision.
	if !n.conns.Connected(remote, time.Now()) {
		_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
		if _, err := s.Write([]byte{respNoConn}); err == nil {
			ok = true
		}
		return
	}
	n.conns.Touch(remote, time.Now())

	decision := make(chan bool, 1)
	n.pending.Store(offer.TransferID, decision)
	defer n.pending.Delete(offer.TransferID)

	n.emit(EventIncoming, offer)

	var accepted, answered bool
	select {
	case accepted = <-decision:
		answered = true
	case <-time.After(n.decisionWait):
	case <-n.ctx.Done():
		return
	}

	_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
	if !accepted {
		resp := respNoAnswer
		if answered {
			resp = respDecline
		}
		if _, err := s.Write([]byte{resp}); err == nil {
			ok = true
		}
		return
	}
	if _, err := s.Write([]byte{respAccept}); err != nil {
		return
	}

	_ = s.SetReadDeadline(time.Now().Add(payloadDeadline(offer.Scope)))
	payload, err := readPayload(br, payloadLimit(offer.Scope))
	if err != nil {
		n.emit(EventError, map[string]string{
			"transferId": offer.TransferID,
			"message":    "Transfer failed: " + err.Error(),
		})
		return
	}

	summary := "Imported nothing"
	if n.onPayload != nil {
		summary = n.onPayload(payload)
	}

	// Confirm before announcing, so the sender's "Sent" and the receiver's
	// "Imported" describe the same completed event.
	_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
	if _, err := s.Write([]byte{respDone}); err == nil {
		ok = true
	}

	n.emit(EventImported, map[string]any{
		"transferId": offer.TransferID,
		"fromName":   offer.FromName,
		"summary":    summary,
	})
}

// handleConnect serves a connection request: put it in front of this device's
// user, wait for them to type the code the sender is reading out, and open the
// connection if it matches. Reports whether the exchange completed, which is
// what decides between a graceful close and a reset.
//
// Only the hash of the code arrives, so this device cannot show it — its user
// can only have got it from the person asking to connect. That is the whole
// mechanism: the code proves a conversation happened between two people, which
// is precisely what a stranger on the same Wi-Fi cannot produce.
func (n *Node) handleConnect(s network.Stream, remote peer.ID, offer models.ShareOffer, codeHash string) bool {
	// A request with no code behind it could only ever be accepted by guessing
	// nothing, so it is refused rather than shown.
	if codeHash == "" {
		_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
		_, err := s.Write([]byte{respDecline})
		return err == nil
	}

	req := &connReq{
		peer:     remote,
		fromName: offer.FromName,
		codeHash: codeHash,
		decision: make(chan bool, 1),
	}
	n.connPending.Store(offer.TransferID, req)
	defer n.connPending.Delete(offer.TransferID)

	n.emit(EventConnectRequest, map[string]string{
		"requestId": offer.TransferID,
		"peerId":    remote.String(),
		"fromName":  offer.FromName,
	})

	var accepted, answered bool
	select {
	case accepted = <-req.decision:
		answered = true
	case <-time.After(n.decisionWait):
	case <-n.ctx.Done():
		return false
	}

	// Whatever happened, the prompt is finished with — including on a timeout,
	// where nobody pressed anything and the dialog would otherwise sit there.
	n.emit(EventConnectClosed, map[string]string{"requestId": offer.TransferID})

	resp := respNoAnswer
	switch {
	case accepted:
		n.conns.Open(remote, time.Now())
		resp = respAccept
	case answered:
		resp = respDecline
	}

	_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
	_, err := s.Write([]byte{resp})
	return err == nil
}

// AnswerConnect delivers a code typed into the connection prompt.
//
// Returns whether it matched and how many attempts are left, so the dialog can
// count down rather than silently dropping the request on the fifth try.
func (n *Node) AnswerConnect(requestID, code string) (matched bool, remaining int, found bool) {
	v, ok := n.connPending.Load(requestID)
	if !ok {
		return false, 0, false
	}
	req, ok := v.(*connReq)
	if !ok {
		return false, 0, false
	}
	matched, remaining = req.Answer(code)
	return matched, remaining, true
}

// DeclineConnect refuses a pending connection request.
func (n *Node) DeclineConnect(requestID string) bool {
	v, ok := n.connPending.Load(requestID)
	if !ok {
		return false
	}
	req, ok := v.(*connReq)
	if !ok {
		return false
	}
	req.Decline()
	return true
}

// DismissConnect closes an established connection, so a device that was let in
// earlier has to ask again.
func (n *Node) DismissConnect(peerID string) {
	id, err := peer.Decode(peerID)
	if err != nil {
		return
	}
	n.conns.Forget(id)
}

// Respond delivers the user's decision to a blocked handler. Reports whether a
// transfer was actually waiting, so a stale modal cannot silently no-op.
func (n *Node) Respond(transferID string, accept bool) bool {
	v, ok := n.pending.LoadAndDelete(transferID)
	if !ok {
		return false
	}
	ch, ok := v.(chan bool)
	if !ok {
		return false
	}
	select {
	case ch <- accept:
		return true
	default:
		return false
	}
}

// readPayload decompresses and decodes a payload, bounded by limit.
func readPayload(r io.Reader, limit int64) (models.SharePayload, error) {
	var out models.SharePayload

	gz, err := gzip.NewReader(io.LimitReader(r, limit))
	if err != nil {
		return out, fmt.Errorf("gzip: %w", err)
	}
	defer func() { _ = gz.Close() }()

	// The limit is applied again after decompression: the first bound caps what
	// arrives on the wire, this one caps what it expands to.
	if err := json.NewDecoder(io.LimitReader(gz, limit)).Decode(&out); err != nil {
		return out, fmt.Errorf("decode: %w", err)
	}
	return out, nil
}

// payloadLimit and payloadDeadline are chosen from the offer's scope rather than
// being one generous constant, so a config transfer keeps the tight bound it has
// always had and only a file transfer pays for the larger one.
func payloadLimit(scope string) int64 {
	if scope == ScopeFiles {
		return maxFilePayload
	}
	return maxPayload
}

func payloadDeadline(scope string) time.Duration {
	if scope == ScopeFiles {
		return filePayloadTimeout
	}
	return payloadTimeout
}

// RequestConnect asks a peer to open a conversation, before anything has been
// chosen to send.
//
// The code is generated and displayed here, on the sending side, and read out
// to the other person. Only its hash is sent, so the receiving device cannot
// display it — its user has to be told, which is what makes possession of the
// code evidence that two people actually spoke.
//
// Blocks until that user answers. Returns nil once they have typed the code
// correctly, and ErrDeclined if they refused, ran out of attempts, or never
// answered.
func (n *Node) RequestConnect(ctx context.Context, peerID, code string) error {
	h := n.host
	if h == nil {
		return errors.New("discovery is not running")
	}

	id, err := peer.Decode(peerID)
	if err != nil {
		return fmt.Errorf("bad peer id: %w", err)
	}

	s, err := h.NewStream(ctx, id, ShareProto)
	if err != nil {
		if isUnsupported(err) {
			return ErrOldVersion
		}
		return fmt.Errorf("open stream: %w", err)
	}
	ok := false
	defer func() {
		if ok {
			_ = s.Close()
			return
		}
		_ = s.Reset()
	}()

	if err := s.SetWriteDeadline(time.Now().Add(offerTimeout)); err != nil {
		return err
	}
	// The code itself never leaves this machine.
	offer := models.ShareOffer{
		TransferID: fmt.Sprintf("%d", time.Now().UnixNano()),
		Kind:       models.OfferKindConnect,
		PIN:        HashPIN(code),
	}
	if err := json.NewEncoder(s).Encode(offer); err != nil {
		return fmt.Errorf("send connect request: %w", err)
	}

	// The same allowance the payload path gives: there is a person at the other
	// end reading eight characters off a screen and typing them.
	if err := s.SetReadDeadline(time.Now().Add(decisionTimeout)); err != nil {
		return err
	}
	var resp [1]byte
	if _, err := io.ReadFull(s, resp[:]); err != nil {
		return fmt.Errorf("await response: %w", err)
	}

	switch resp[0] {
	case respAccept:
		ok = true
		return nil
	case respDecline, respBadPIN:
		// Both mean the same thing to the sender: they said no. Which of the two
		// it was is the other user's business, not ours.
		ok = true
		return ErrDeclined
	case respNoAnswer:
		ok = true
		return ErrNoAnswer
	default:
		return fmt.Errorf("unexpected response %#x", resp[0])
	}
}

// displayName prefers the name we resolved over the wire during hello over the
// one the sender put in its own header.
func (n *Node) displayName(id peer.ID, claimed string) string {
	n.mu.Lock()
	rec, ok := n.peers[id]
	n.mu.Unlock()

	if ok && rec.announced && rec.info.Name != "" {
		return rec.info.Name
	}
	return NormalizeName(claimed, id.String())
}

// newTransferID namespaces the sender's ID by peer, so two peers cannot collide
// and neither can spoof the other's in-flight transfer.
func newTransferID(id peer.ID, claimed string) string {
	if claimed == "" {
		claimed = "t"
	}
	if len(claimed) > 64 {
		claimed = claimed[:64]
	}
	return id.String() + ":" + claimed
}

// isUnsupported reports whether a dial failed because the peer does not speak
// this protocol version.
//
// Matched on the message rather than a sentinel: go-multistream returns a
// generic ErrNotSupported[T] whose instances do not compare equal, and libp2p
// wraps it on the way out. A false negative here only costs a vaguer message,
// which is why a string match is an acceptable trade.
func isUnsupported(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not supported") ||
		strings.Contains(msg, "protocol not supported") ||
		strings.Contains(msg, "failed to negotiate")
}
