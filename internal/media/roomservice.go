package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	adminTTL       = time.Minute
	requestTimeout = 5 * time.Second
	retryDelay     = time.Second
	maxErrorBody   = 4 << 10
	maxListBody    = 4 << 20

	removePath = "/twirp/livekit.RoomService/RemoveParticipant"
	listPath   = "/twirp/livekit.RoomService/ListParticipants"
)

var errRetryable = errors.New("retryable")

type adminClaims struct {
	Iss   string     `json:"iss"`
	Nbf   int64      `json:"nbf"`
	Iat   int64      `json:"iat"`
	Exp   int64      `json:"exp"`
	Video adminGrant `json:"video"`
}

// adminGrant administers a single room and cannot join it.
type adminGrant struct {
	Room      string `json:"room"`
	RoomAdmin bool   `json:"roomAdmin"`
}

type statusError struct {
	status int
	code   string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("status %d %s", e.status, e.code)
}

func notFound(err error) bool {
	var se *statusError
	return errors.As(err, &se) && (se.status == http.StatusNotFound || se.code == "not_found")
}

// Remove disconnects identity from room and reports whether it was there;
// a participant that is not there is not an error. Network errors and 5xx
// answers are retried once.
func (c *Client) Remove(ctx context.Context, room, identity string) (bool, error) {
	found, err := c.remove(ctx, room, identity)
	if !errors.Is(err, errRetryable) {
		return found, err
	}
	t := time.NewTimer(retryDelay)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false, err
	case <-t.C:
	}
	return c.remove(ctx, room, identity)
}

func (c *Client) remove(ctx context.Context, room, identity string) (bool, error) {
	err := c.post(ctx, room, removePath, struct {
		Room     string `json:"room"`
		Identity string `json:"identity"`
	}{room, identity}, nil)
	switch {
	case err == nil:
		return true, nil
	case notFound(err):
		return false, nil
	}
	return false, fmt.Errorf("remove participant: %w", err)
}

// Participants lists the identities connected to room; a room that does not
// exist has none.
func (c *Client) Participants(ctx context.Context, room string) ([]string, error) {
	var out struct {
		Participants []struct {
			Identity string `json:"identity"`
		} `json:"participants"`
	}
	err := c.post(ctx, room, listPath, struct {
		Room string `json:"room"`
	}{room}, &out)
	if notFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	ids := make([]string, len(out.Participants))
	for i, p := range out.Participants {
		ids[i] = p.Identity
	}
	return ids, nil
}

// post calls a room service method with an admin token for room and decodes
// a 200 answer into out. Its errors never carry the token.
func (c *Client) post(ctx context.Context, room, path string, in, out any) error {
	token, err := c.adminToken(room, time.Now())
	if err != nil {
		return err
	}
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %w", errRetryable, err)
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusOK {
		if out == nil {
			return nil
		}
		return json.NewDecoder(io.LimitReader(res.Body, maxListBody)).Decode(out)
	}
	var twirp struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, maxErrorBody)).Decode(&twirp)
	err = &statusError{res.StatusCode, twirp.Code}
	if res.StatusCode >= 500 {
		return fmt.Errorf("%w: %w", errRetryable, err)
	}
	return err
}

func (c *Client) adminToken(room string, now time.Time) (string, error) {
	return sign(adminClaims{
		Iss:   c.key,
		Nbf:   now.Unix(),
		Iat:   now.Unix(),
		Exp:   now.Add(adminTTL).Unix(),
		Video: adminGrant{Room: room, RoomAdmin: true},
	}, c.secret)
}
