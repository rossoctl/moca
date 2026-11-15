package guestagent

import (
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// The agent is PID 1: if Serve returns, main's log.Fatalf exits init and the guest kernel
// panics. Task 11's rig run found exactly that, from an accept interrupted by the SIGCHLD of
// a tracked process's exit (fix round 1, item 1).

func TestAcceptRetryable(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{syscall.EINTR, true},
		{fmt.Errorf("guestagent: vsock accept: %w", syscall.EINTR), true},
		{syscall.ECONNABORTED, true},
		{syscall.EAGAIN, false}, // waited on, not retried at once: nothing is pending
		{syscall.EMFILE, false}, // Serve backs off on it instead
		{net.ErrClosed, false},
		{errors.New("something else"), false},
		{nil, false},
	} {
		if got := acceptRetryable(tc.err); got != tc.want {
			t.Errorf("acceptRetryable(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

// injectingListener fails its first Accept with err, then defers to the real listener.
type injectingListener struct {
	net.Listener
	err  error
	once sync.Once
}

func (l *injectingListener) Accept() (net.Conn, error) {
	var inject bool
	l.once.Do(func() { inject = true })
	if inject {
		return nil, l.err
	}
	return l.Listener.Accept()
}

// TestServeKeepsServingAfterAnAcceptError: an accept error other than a closed listener
// (an interrupted accept, as on the rig, or EMFILE) is retried; only a closed listener ends
// Serve, and then with net.ErrClosed.
func TestServeKeepsServingAfterAnAcceptError(t *testing.T) {
	for _, injected := range []error{
		fmt.Errorf("guestagent: vsock accept: %w", syscall.EINTR),
		fmt.Errorf("guestagent: vsock accept: %w", syscall.EMFILE),
	} {
		t.Run(injected.Error(), func(t *testing.T) {
			a := newTestAgent(t)
			dir := shortdir.New(t, "sh-ga-", len("/s.sock"))
			real, err := net.Listen("unix", filepath.Join(dir, "s.sock"))
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- a.Serve(&injectingListener{Listener: real, err: injected}) }()

			c, err := net.Dial("unix", real.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			_ = c.SetDeadline(time.Now().Add(5 * time.Second))
			// Not a request frame: the agent answers an error frame, which proves this
			// connection was accepted and served after the injected failure.
			if err := WriteFrame(c, KindStdinEOF, nil); err != nil {
				t.Fatal(err)
			}
			kind, payload, err := ReadFrame(c)
			if err != nil || kind != KindError {
				t.Fatalf("after the injected accept error: frame %#x %q, %v; want the agent's error frame", byte(kind), payload, err)
			}
			_ = c.Close()

			_ = real.Close()
			select {
			case err := <-done:
				if !errors.Is(err, net.ErrClosed) {
					t.Fatalf("Serve returned %v, want net.ErrClosed", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("Serve did not return after its listener closed")
			}
		})
	}
}
