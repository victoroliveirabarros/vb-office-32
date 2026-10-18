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

	removePath = "/twirp/livekit.RoomService/RemoveParticipant"
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

// Remove disconnects identity from room. A participant that is not there
// counts as removed. Network errors and 5xx answers are retried once.
func (c *Client) Remove(ctx context.Context, room, identity string) error {
	err := c.remove(ctx, room, identity)
	if !errors.Is(err, errRetryable) {
		return err
	}
	t := time.NewTimer(retryDelay)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return err
	case <-t.C:
	}
	return c.remove(ctx, room, identity)
}

// remove never puts the admin token in its errors.
func (c *Client) remove(ctx context.Context, room, identity string) error {
	token, err := c.adminToken(room, time.Now())
	if err != nil {
		return err
	}
	body, err := json.Marshal(struct {
		Room     string `json:"room"`
		Identity string `json:"identity"`
	}{room, identity})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+removePath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("remove participant: %w: %w", errRetryable, err)
	}
	defer res.Body.Close()
	var twirp struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, maxErrorBody)).Decode(&twirp)

	switch {
	case res.StatusCode == http.StatusOK, res.StatusCode == http.StatusNotFound, twirp.Code == "not_found":
		return nil
	case res.StatusCode >= 500:
		return fmt.Errorf("remove participant: %w: status %d %s", errRetryable, res.StatusCode, twirp.Code)
	}
	return fmt.Errorf("remove participant: status %d %s", res.StatusCode, twirp.Code)
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
