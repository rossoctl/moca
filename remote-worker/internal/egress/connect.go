package egress

import (
	"bufio"
	"io"
	"net"
	"sync"
	"sync/atomic"
)

const connectEstablished = "HTTP/1.1 200 Connection Established\r\n\r\n"

type closeWriter interface{ CloseWrite() error }

// tunnel answers a checked CONNECT and splices opaquely until both directions
// end. Bytes the guest sent behind the CONNECT request, already buffered in
// br, go upstream first because the guest side is read through br.
func (pc *proxyConn) tunnel(up net.Conn, br *bufio.Reader, ev Event) {
	var bytesUp, bytesDown atomic.Int64
	// One clock for both conns, both directions. A bound that watched only the
	// conn a given leg reads would expire mid-transfer on any one-way traffic:
	// during a git clone the guest sends nothing for as long as the pack takes
	// to stream down, so the guest→up leg's read would time out on a healthy
	// tunnel.
	k := bothWays(pc.c, up, pc.p.cfg.IdleTimeout)
	k.touch()
	if _, err := io.WriteString(pc.c, connectEstablished); err == nil {
		splice(pc.c, br, up, k, &bytesUp, &bytesDown)
	}
	// The slot goes back before the event, so the event is proof that it is
	// free (#783). After a splice the guest conn's close has released it
	// already; this covers a tunnel whose 200 could not be written.
	pc.release()
	ev.Status, ev.Decision = 200, DecisionTunnel
	ev.BytesUp, ev.BytesDown = bytesUp.Load(), bytesDown.Load()
	pc.emit(ev, true) // suppressed if Unregister aborted the conn
}

// splice copies client→up (reading through cr) and up→client. On EOF in one
// direction the destination's write side is half-closed (or the destination
// closed, if it cannot half-close) and the other direction keeps flowing. A
// copy error tears both conns down. It mirrors the guest forwarder's splice.
//
// k bounds the tunnel as a whole: both legs refresh the one clock, and it is
// refreshed per read and per write, so only a tunnel where nothing moves at
// all expires. Both legs and both directions matter. A half-closed tunnel
// leaves exactly one leg running, so bounding only the guest's reads would
// leave a client that sent CloseWrite and then waits on a silent upstream
// holding its slot indefinitely; and bounding each leg separately would expire
// a healthy one-way transfer, which is the case this shape exists to protect.
// Because an expiry is a copy error, it lands in the arm that already tears
// both conns down.
func splice(client net.Conn, cr io.Reader, up net.Conn, k *idleClock, nUp, nDown *atomic.Int64) {
	var wg sync.WaitGroup
	var once sync.Once
	closeBoth := func() { _ = client.Close(); _ = up.Close() }
	pipe := func(dst net.Conn, sr io.Reader, n *atomic.Int64) {
		defer wg.Done()
		if err := copyCounted(idleWriter{c: dst, k: k}, idleReader{r: sr, k: k}, n); err != nil {
			once.Do(closeBoth)
			return
		}
		if cw, ok := dst.(closeWriter); ok {
			if cw.CloseWrite() != nil {
				once.Do(closeBoth)
			}
		} else {
			_ = dst.Close()
		}
	}
	wg.Add(2)
	go pipe(up, cr, nUp)
	go pipe(client, up, nDown)
	wg.Wait()
	once.Do(closeBoth)
}

func copyCounted(dst io.Writer, src io.Reader, n *atomic.Int64) error {
	buf := make([]byte, 32*1024)
	for {
		r, err := src.Read(buf)
		if r > 0 {
			w, werr := dst.Write(buf[:r])
			n.Add(int64(w))
			if werr != nil {
				return werr
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
