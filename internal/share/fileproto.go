package share

import (
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

const (
	// idleTimeout bounds inactivity rather than the transfer as a whole.
	//
	// A single deadline cannot be right for both a 1 MB file and a 1 GB one:
	// generous enough for the large case is useless for the small, and tight
	// enough for the small kills the large. Every chunk pushes the deadline
	// forward, so a stalled peer still dies while a slow one is left alone.
	idleTimeout = 60 * time.Second

	// progressInterval is the shortest gap between two progress events.
	//
	// At copyBufSize a 500 MB transfer moves ~16,000 chunks; emitting one event
	// each would flood the frontend with work nobody can see. A quarter second
	// is well under the threshold where a bar reads as stuck.
	progressInterval = 250 * time.Millisecond
)

// FileProto carries an arbitrary file transfer.
//
// A protocol of its own rather than another scope on ShareProto, because the
// two carry genuinely different things and the split is what keeps them from
// constraining each other: config stays small, structured and gzip'd, while
// this streams opaque bytes straight to disk. It also means a peer that has one
// and not the other degrades honestly — negotiation simply fails, and only for
// the transport it is missing.
const FileProto = "/yv/files/1.0.0"

// SendFiles offers files to a peer and, if accepted, streams them.
//
// The bytes never pass through JSON, base64 or gzip: only a small header per
// file is structured, and the body after it is copied verbatim. That is what
// makes an .apk or a .zip cost the same as text, and what keeps memory at one
// copyBufSize buffer regardless of how large the file is.
func (n *Node) SendFiles(ctx context.Context, peerID string, offer models.ShareOffer, files []FileSource) error {
	h := n.host
	if h == nil {
		return errors.New("discovery is not running")
	}

	id, err := peer.Decode(peerID)
	if err != nil {
		return fmt.Errorf("bad peer id: %w", err)
	}

	defer n.beginTransfer(id)()

	s, err := h.NewStream(ctx, id, FileProto)
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
	case respNoConn:
		ok = true
		return ErrNotConnected
	case respNoSpace:
		ok = true
		return ErrNoSpace
	case respNoAnswer:
		ok = true
		return ErrNoAnswer
	case respDecline:
		ok = true
		return ErrDeclined
	default:
		return fmt.Errorf("unexpected response %#x", resp[0])
	}

	total := TotalBytes(files)
	report := n.progressReporter(offer.TransferID, "send", total)

	// The deadline moves with the data rather than bounding the whole transfer.
	body := &touchWriter{w: s, touch: func() {
		_ = s.SetWriteDeadline(time.Now().Add(idleTimeout))
	}}

	if err := WriteFiles(body, files, report); err != nil {
		return err
	}

	// CloseWrite is the terminator: the receiver reads frames until EOF, so
	// there is no count on the wire to disagree with what actually arrived.
	if err := s.CloseWrite(); err != nil {
		return fmt.Errorf("close write: %w", err)
	}

	if err := s.SetReadDeadline(time.Now().Add(idleTimeout)); err != nil {
		return err
	}
	if _, err := io.ReadFull(s, resp[:]); err != nil {
		return fmt.Errorf("await confirmation: %w", err)
	}
	if resp[0] != respDone {
		return fmt.Errorf("the other device could not save the files")
	}

	ok = true
	return nil
}

// handleFiles serves an inbound file transfer.
//
// Identical to handleShare up to the accept byte — both call the same gate, so
// the connection requirement and the user's prompt have one implementation —
// and different only in how the body is read.
func (n *Node) handleFiles(s network.Stream) {
	ok := false
	defer func() {
		if ok {
			_ = s.Close()
			return
		}
		_ = s.Reset()
	}()

	in, read := n.readOffer(s)
	if !read {
		return
	}
	defer n.beginTransfer(in.remote)()

	// This transport carries nothing else; a connect request belongs on
	// ShareProto and arriving here means a peer that does not follow it.
	if in.offer.Kind != "" {
		return
	}

	switch n.gate(s, in, n.spaceCheck) {
	case offerRefused:
		ok = true
		return
	case offerBroken:
		return
	}

	if n.onFiles == nil {
		return
	}

	report := n.progressReporter(in.offer.TransferID, "receive", in.offer.TotalBytes)
	body := &touchReader{r: in.body, touch: func() {
		_ = s.SetReadDeadline(time.Now().Add(idleTimeout))
	}}

	summary, err := n.onFiles(in.offer, body, report)
	if err != nil {
		n.emit(EventError, map[string]string{
			"transferId": in.offer.TransferID,
			"message":    "Transfer failed: " + err.Error(),
		})
		return
	}

	_ = s.SetWriteDeadline(time.Now().Add(offerTimeout))
	if _, err := s.Write([]byte{respDone}); err == nil {
		ok = true
	}

	n.emit(EventImported, map[string]any{
		"transferId": in.offer.TransferID,
		"fromName":   in.offer.FromName,
		"summary":    summary,
	})
}

// spaceCheck refuses a transfer that cannot fit, before anyone is asked about
// it. An unmeasurable disk is treated as room enough: refusing because we could
// not look would block transfers that would have worked, and the write itself
// still fails safely.
func (n *Node) spaceCheck(offer models.ShareOffer) byte {
	if offer.TotalBytes <= 0 {
		return 0
	}
	dir, err := ReceiveDir()
	if err != nil {
		return 0
	}
	free, known := FreeSpace(dir)
	if !known {
		return 0
	}

	// A margin, because landing a transfer that fills the disk to the last byte
	// is barely better than refusing it.
	if free-spaceMargin < offer.TotalBytes {
		n.emit(EventError, map[string]string{
			"transferId": offer.TransferID,
			"message": fmt.Sprintf("%s tried to send %s, but there is only %s free.",
				offer.FromName, HumanSize(offer.TotalBytes), HumanSize(free)),
		})
		return respNoSpace
	}
	return 0
}

// spaceMargin is left free after a transfer lands.
const spaceMargin int64 = 128 << 20 // 128 MB

// progressReporter returns a throttled callback that emits share:progress.
//
// Throttled by time rather than by byte count so the rate is the same on a fast
// link and a slow one. The final value is not forced through here — the summary
// that follows is what says the transfer finished — so a bar should be driven
// to completion by the done state, not by waiting for a last event.
func (n *Node) progressReporter(transferID, direction string, total int64) func(int64) {
	last := time.Now()
	return func(bytes int64) {
		now := time.Now()
		if now.Sub(last) < progressInterval {
			return
		}
		last = now
		n.emit(EventProgress, map[string]any{
			"transferId": transferID,
			"direction":  direction,
			"bytes":      bytes,
			"total":      total,
		})
	}
}

// touchReader and touchWriter push a stream deadline forward as data moves, so
// the bound is on going quiet rather than on taking a long time.
type touchReader struct {
	r     io.Reader
	touch func()
}

func (t *touchReader) Read(p []byte) (int, error) {
	t.touch()
	return t.r.Read(p)
}

type touchWriter struct {
	w     io.Writer
	touch func()
}

func (t *touchWriter) Write(p []byte) (int, error) {
	t.touch()
	return t.w.Write(p)
}
