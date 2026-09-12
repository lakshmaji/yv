package logger

import (
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestInit(t *testing.T) {
	cases := []struct {
		name    string
		dsn     string
		wantErr bool
	}{
		{name: "empty dsn is console-only, no error", dsn: "", wantErr: false},
		{name: "malformed dsn errors but still leaves logging usable", dsn: "not-a-valid-dsn", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flush, err := Init(tc.dsn, "test")
			if (err != nil) != tc.wantErr {
				t.Fatalf("Init(%q) error = %v, wantErr %v", tc.dsn, err, tc.wantErr)
			}
			flush(0)      // must never block or panic, regardless of dsn validity
			Info("hello") // must never panic through a possibly-unconfigured Sentry handler
		})
	}
}

func TestRecoverSwallowsPanic(t *testing.T) {
	Init("", "test")

	cases := []struct {
		name       string
		panicValue any
	}{
		{name: "string panic", panicValue: "boom"},
		{name: "error panic", panicValue: errors.New("boom")},
		{name: "struct panic", panicValue: struct{ Code int }{Code: 500}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan struct{})
			go func() {
				defer close(done)
				defer Recover("test-goroutine")
				panic(tc.panicValue)
			}()
			select {
			case <-done:
				// Recover swallowed it — the goroutine returned instead of
				// crashing the test binary.
			case <-time.After(2 * time.Second):
				t.Fatal("goroutine never returned — Recover did not swallow the panic")
			}
		})
	}
}

func TestBreadcrumbLevel(t *testing.T) {
	cases := []struct {
		name string
		in   slog.Level
		want sentry.Level
	}{
		{name: "debug", in: slog.LevelDebug, want: sentry.LevelDebug},
		{name: "info", in: slog.LevelInfo, want: sentry.LevelInfo},
		{name: "warn", in: slog.LevelWarn, want: sentry.LevelWarning},
		{name: "error", in: slog.LevelError, want: sentry.LevelError},
		{name: "above error clamps to error", in: slog.LevelError + 4, want: sentry.LevelError},
		{name: "between info and warn falls back to info", in: slog.LevelInfo + 1, want: sentry.LevelInfo},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := breadcrumbLevel(tc.in); got != tc.want {
				t.Errorf("breadcrumbLevel(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
