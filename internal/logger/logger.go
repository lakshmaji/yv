// Package logger is the one place in this codebase that imports log/slog or
// sentry-go. Every log line and every crash report goes through the
// package-level functions here, so a call site never picks its own logging
// strategy and a change to what "reporting a crash" means has one function
// to touch.
//
// A provider is anything implementing slog.Handler: the console provider is
// genuinely stdlib (slog.NewTextHandler); Sentry is a small custom Handler
// built on sentry-go. "Registering a provider" is composing both into the
// one fan-out handler multiHandler wraps below — there is no plugin
// interface beyond the one slog already defines.
//
// Sentry is optional and off by default: Init treats an empty DSN as
// "console only," which is what `wails dev`, `go build`, and any fork build
// without the release secret get. A shipped build gets its DSN baked in at
// link time via -ldflags, the same mechanism main.version already uses.
package logger

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime/debug"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
)

var (
	mu    sync.Mutex
	def   = slog.Default() // console-only fallback if Init is never called (e.g. in tests)
	flush = func(time.Duration) {}
)

// Init wires up the console provider unconditionally and the Sentry provider
// only when dsn is non-empty, then installs the result as both this
// package's default and slog's package default (defensive: nothing in this
// codebase should call log/slog directly, but if something slips through,
// it still lands on the console).
//
// The returned flush must be deferred by main() before the process exits; it
// is a no-op when Sentry was not configured.
func Init(dsn, release string) (func(timeout time.Duration), error) {
	console := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})
	handlers := []slog.Handler{console}

	var initErr error
	newFlush := func(time.Duration) {}

	if dsn != "" {
		if err := sentry.Init(sentry.ClientOptions{
			Dsn:              dsn,
			Release:          release,
			AttachStacktrace: true,
		}); err != nil {
			initErr = fmt.Errorf("sentry.Init: %w", err)
		} else {
			handlers = append(handlers, &sentryHandler{})
			newFlush = func(timeout time.Duration) { sentry.Flush(timeout) }
		}
	}

	l := slog.New(newMultiHandler(handlers...))

	mu.Lock()
	def = l
	flush = newFlush
	mu.Unlock()
	slog.SetDefault(l)

	return newFlush, initErr
}

func current() *slog.Logger {
	mu.Lock()
	defer mu.Unlock()
	return def
}

func Debug(msg string, args ...any) { current().Debug(msg, args...) }
func Info(msg string, args ...any)  { current().Info(msg, args...) }
func Warn(msg string, args ...any)  { current().Warn(msg, args...) }

// Error logs at error level. err is threaded through as an "error"-keyed
// attr rather than baked into msg, so sentryHandler can pull the real error
// value back out and call CaptureException with it instead of a flattened
// string that loses its type.
func Error(msg string, err error, args ...any) {
	current().Error(msg, append([]any{"error", err}, args...)...)
}

// Fatal logs at error level, flushes whatever provider was configured
// (os.Exit skips deferred calls, so this cannot rely on main()'s own defer),
// and exits 1. Replacement for the two log.Fatal call sites in main.go.
func Fatal(msg string, err error, args ...any) {
	Error(msg, err, args...)
	mu.Lock()
	f := flush
	mu.Unlock()
	f(2 * time.Second)
	os.Exit(1)
}

// Recover is deferred at the top of a background goroutine. On a panic it
// logs (console + Sentry, same path as Error) with the goroutine's stack
// attached, flushes with a short deadline, and returns — the goroutine ends
// quietly rather than taking the whole process down with it.
//
// It deliberately does not re-panic. Every current call site is a fire-and-
// forget background worker (scan monitor, update watch, resource monitor,
// fullscreen poll, metrics prune) with no caller waiting on a return value;
// a goroutine that silently stops is strictly better than the status quo,
// which is the whole process crashing with nothing reported at all. See
// main.go for the one place this package treats a top-level panic
// differently.
func Recover(component string) {
	r := recover()
	if r == nil {
		return
	}
	err := fmt.Errorf("panic in %s: %v", component, r)
	Error("panic recovered", err, "component", component, "stack", string(debug.Stack()))
	mu.Lock()
	f := flush
	mu.Unlock()
	f(2 * time.Second)
}

// ── multiHandler: the one bit of unavoidable custom plumbing ──────────────

// multiHandler fans a slog.Record out to every registered provider. slog has
// no built-in equivalent.
type multiHandler struct {
	handlers []slog.Handler
}

func newMultiHandler(handlers ...slog.Handler) *multiHandler {
	return &multiHandler{handlers: handlers}
}

func (m *multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range m.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (m *multiHandler) Handle(ctx context.Context, r slog.Record) error {
	var errs []error
	for _, h := range m.handlers {
		if !h.Enabled(ctx, r.Level) {
			continue
		}
		// Cloned per handler: slog.Record's Attrs are a shared internal
		// buffer, and a Handle implementation that iterates it (both of
		// ours do) must not be handed the same Record another handler is
		// also iterating.
		if err := h.Handle(ctx, r.Clone()); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (m *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		next[i] = h.WithAttrs(attrs)
	}
	return &multiHandler{handlers: next}
}

func (m *multiHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		next[i] = h.WithGroup(name)
	}
	return &multiHandler{handlers: next}
}

// ── Sentry provider ─────────────────────────────────────────────────────

// sentryHandler turns an Error-level record into a Sentry issue and
// everything below Error into a breadcrumb — cheap context that rides along
// with whatever error eventually happens, rather than being dropped.
type sentryHandler struct {
	attrs []slog.Attr
}

func (h *sentryHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *sentryHandler) Handle(_ context.Context, r slog.Record) error {
	data := make(map[string]any, r.NumAttrs()+len(h.attrs))
	for _, a := range h.attrs {
		data[a.Key] = a.Value.Any()
	}
	var errAttr error
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "error" {
			if e, ok := a.Value.Any().(error); ok {
				errAttr = e
				return true
			}
		}
		data[a.Key] = a.Value.Any()
		return true
	})

	if r.Level >= slog.LevelError {
		sentry.WithScope(func(scope *sentry.Scope) {
			scope.SetContext("log", data)
			if errAttr != nil {
				sentry.CaptureException(errAttr)
			} else {
				sentry.CaptureMessage(r.Message)
			}
		})
		return nil
	}

	sentry.AddBreadcrumb(&sentry.Breadcrumb{
		Category:  "log",
		Message:   r.Message,
		Level:     breadcrumbLevel(r.Level),
		Data:      data,
		Timestamp: r.Time,
	})
	return nil
}

func (h *sentryHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := &sentryHandler{attrs: make([]slog.Attr, 0, len(h.attrs)+len(attrs))}
	next.attrs = append(next.attrs, h.attrs...)
	next.attrs = append(next.attrs, attrs...)
	return next
}

// WithGroup drops grouping rather than modeling it: every call site in this
// codebase logs flat key=value attrs, none uses slog.Group.
func (h *sentryHandler) WithGroup(string) slog.Handler { return h }

func breadcrumbLevel(l slog.Level) sentry.Level {
	switch {
	case l >= slog.LevelError:
		return sentry.LevelError
	case l >= slog.LevelWarn:
		return sentry.LevelWarning
	case l >= slog.LevelInfo:
		return sentry.LevelInfo
	default:
		return sentry.LevelDebug
	}
}
