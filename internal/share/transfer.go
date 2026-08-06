package share

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

	// maxPayload caps a decompressed payload. Config files are small; this
	// exists so a hostile peer cannot make us allocate without bound through
	// the decompressor.
	maxPayload = 16 << 20 // 16 MB
)

// ErrDeclined and ErrBadPIN distinguish the two refusals a sender can get, so
// the UI can say "declined" rather than a generic failure.
var (
	ErrDeclined = errors.New("the other device declined the transfer")
	ErrBadPIN   = errors.New("incorrect PIN")
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

// handleShare serves an inbound transfer: read the offer, check the PIN, ask the
// user, and on acceptance apply the payload.
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

	if !PINMatches(n.requiredPIN(), offer.PIN) {
		_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
		if _, err := s.Write([]byte{respBadPIN}); err == nil {
			ok = true
		}
		// Deliberately no share:incoming event: a wrong PIN must not be able to
		// put a prompt on the receiver's screen, or the PIN would gate nothing.
		return
	}

	// Trust the connection for identity, not the header: FromName is display
	// text from another machine, so fall back to what we already resolved for
	// this peer rather than showing whatever it claims.
	offer.TransferID = newTransferID(remote, offer.TransferID)
	offer.FromName = n.displayName(remote, offer.FromName)
	offer.PIN = ""

	decision := make(chan bool, 1)
	n.pending.Store(offer.TransferID, decision)
	defer n.pending.Delete(offer.TransferID)

	n.emit(EventIncoming, offer)

	var accepted bool
	select {
	case accepted = <-decision:
	case <-time.After(decisionTimeout):
		accepted = false
	case <-n.ctx.Done():
		return
	}

	_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
	if !accepted {
		if _, err := s.Write([]byte{respDecline}); err == nil {
			ok = true
		}
		return
	}
	if _, err := s.Write([]byte{respAccept}); err != nil {
		return
	}

	_ = s.SetReadDeadline(time.Now().Add(payloadTimeout))
	payload, err := readPayload(br)
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

// readPayload decompresses and decodes a payload, bounded by maxPayload.
func readPayload(r io.Reader) (models.SharePayload, error) {
	var out models.SharePayload

	gz, err := gzip.NewReader(io.LimitReader(r, maxPayload))
	if err != nil {
		return out, fmt.Errorf("gzip: %w", err)
	}
	defer func() { _ = gz.Close() }()

	// The limit is applied again after decompression: the first bound caps what
	// arrives on the wire, this one caps what it expands to.
	if err := json.NewDecoder(io.LimitReader(gz, maxPayload)).Decode(&out); err != nil {
		return out, fmt.Errorf("decode: %w", err)
	}
	return out, nil
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
