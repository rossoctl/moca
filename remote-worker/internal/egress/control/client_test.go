//go:build unix

package control

import (
	"net"

	"google.golang.org/protobuf/proto"
)

// roundTrip sends one request on a raw connection and reads its reply inline. It is for
// connections without a reader goroutine (tests driving the server directly).
func roundTrip(conn *net.UnixConn, req proto.Message, fd int) error {
	if err := writeFrame(conn, req, fd); err != nil {
		return err
	}
	body, fds, err := readFrame(conn)
	if err != nil {
		return err
	}
	closeFDs(fds) // replies never carry fds
	return parseReply(body)
}
