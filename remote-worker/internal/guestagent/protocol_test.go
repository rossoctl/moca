package guestagent

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, KindStdout, []byte("hello")); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	if err := WriteFrame(&buf, KindEnd, nil); err != nil {
		t.Fatalf("WriteFrame(empty): %v", err)
	}
	k, p, err := ReadFrame(&buf)
	if err != nil || k != KindStdout || string(p) != "hello" {
		t.Fatalf("first frame: kind=%#x payload=%q err=%v", k, p, err)
	}
	k, p, err = ReadFrame(&buf)
	if err != nil || k != KindEnd || len(p) != 0 {
		t.Fatalf("second frame: kind=%#x payload=%q err=%v", k, p, err)
	}
	if _, _, err := ReadFrame(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("third read: err = %v, want io.EOF", err)
	}
}

func TestReadFrameRejectsAnOversizedLength(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteByte(byte(KindStdout))
	_ = binary.Write(&buf, binary.BigEndian, uint32(MaxFrame+1))
	// A hostile or corrupt length prefix must not make either side allocate
	// arbitrarily — the guest is running attacker-influenced code by construction.
	if _, _, err := ReadFrame(&buf); err == nil || !strings.Contains(err.Error(), "frame too large") {
		t.Fatalf("err = %v, want a frame-too-large refusal", err)
	}
}

func TestReadFrameRejectsATruncatedPayload(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteByte(byte(KindStdout))
	_ = binary.Write(&buf, binary.BigEndian, uint32(10))
	buf.WriteString("abc") // 3 of the promised 10
	// Spec §5.4: a SHORT response is an error, never coerced into a success.
	if _, _, err := ReadFrame(&buf); err == nil {
		t.Fatal("ReadFrame accepted a truncated payload")
	}
}

func TestWriteJSONRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, Request{
		Command: "cat f", TimeoutS: 30, CapBytes: 1 << 20, HasStdin: true, HostUnixNanos: 1757500000000000000,
	}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	k, p, err := ReadFrame(&buf)
	if err != nil || k != KindRequest {
		t.Fatalf("kind=%#x err=%v", k, err)
	}
	var req Request
	if err := DecodeJSON(p, &req); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if req.Command != "cat f" || !req.HasStdin || req.HostUnixNanos == 0 {
		t.Fatalf("req = %+v", req)
	}
}

func TestRequestWithoutLeaseFieldsIsByteIdenticalToToday(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, Request{Command: "true", TimeoutS: 5, CapBytes: 1}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	// omitempty keeps a non-lease request on the wire exactly as it was before the
	// lease fields existed, so an old guest and a new host stay compatible.
	for _, key := range []string{`"lease"`, `"normalise_workspace"`} {
		if strings.Contains(string(p), key) {
			t.Fatalf("request JSON %s carries %s", p, key)
		}
	}
}

func TestRequestLeaseFieldsRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindRequest, Request{Command: "true", Lease: true, NormaliseWorkspace: true}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	var req Request
	if err := DecodeJSON(p, &req); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if !req.Lease || !req.NormaliseWorkspace {
		t.Fatalf("req = %+v, want both lease flags set", req)
	}
}

func TestEndTeardownFailedRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, KindEnd, End{ExitCode: 0, TeardownFailed: true}); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	_, p, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	var e End
	if err := DecodeJSON(p, &e); err != nil {
		t.Fatalf("DecodeJSON: %v", err)
	}
	if !e.TeardownFailed {
		t.Fatalf("end = %+v, want TeardownFailed", e)
	}
}
