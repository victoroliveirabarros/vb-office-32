package realtime

import (
	"context"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
)

// sessionChat is a chat the session already validated and cleaned; to is
// set only for direct.
type sessionChat struct {
	sess  *Session
	cid   string
	scope chat.Scope
	to    string
	text  string
}

func (r *Room) chat(ctx context.Context, c sessionChat) error {
	return submit(ctx, r, r.chats, c)
}

// handleChat routes a chat to its audience and echoes it, with the client's
// cid, to the sender. Nearby is the sender's set as of the last tick. Text,
// recipient and cid never reach the log.
func (r *Room) handleChat(c sessionChat) {
	from := c.sess.id
	if m, ok := r.members[from]; !ok || m.sess != c.sess {
		return
	}
	var target *member
	if c.scope == chat.Direct {
		var ok bool
		if target, ok = r.members[c.to]; !ok {
			r.log.Debug("chat rejected", "id", from, "reason", chatOffline)
			c.sess.sendChatError(c.cid, chatOffline)
			return
		}
	}

	msg := chat.Message{
		ID:       r.ids.Next(),
		At:       time.Now(),
		From:     from,
		FromName: c.sess.name,
		Scope:    c.scope,
		To:       c.to,
		Text:     c.text,
	}
	out, err := encode(typeChat, newChatOut(msg, ""))
	if err != nil {
		r.log.Error("encode chat", "err", err)
		return
	}
	echo, err := encode(typeChat, newChatOut(msg, c.cid))
	if err != nil {
		r.log.Error("encode chat", "err", err)
		return
	}
	c.sess.send(echo)

	switch c.scope {
	case chat.Everyone:
		r.history.Add(msg)
		r.historyMsg = nil
		for id, m := range r.members {
			if id != from {
				m.sess.send(out)
			}
		}
	case chat.Nearby:
		for _, id := range r.space.Nearby(from) {
			if m, ok := r.members[id]; ok {
				m.sess.send(out)
			}
		}
	case chat.Direct:
		target.sess.send(out)
	}
}

// sendHistory sends the last everyone messages, even none.
func (r *Room) sendHistory(s *Session) {
	if r.historyMsg == nil {
		ms := r.history.Messages()
		out := make([]chatOut, len(ms))
		for i, m := range ms {
			out[i] = newChatOut(m, "")
		}
		b, err := encode(typeChatHistory, chatHistoryMsg{Messages: out})
		if err != nil {
			r.log.Error("encode chat history", "err", err)
			return
		}
		r.historyMsg = b
	}
	s.send(r.historyMsg)
}
