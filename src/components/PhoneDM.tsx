
"use client";

import { useState } from "react";

export default function PhoneDM() {
  const [open, setOpen] = useState(false);
  const [au, setAu] = useState("현대 AU");
  const [contact, setContact] = useState("캐릭터 A");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<
    { text: string; mine: boolean }[]
  >([]);

  return (
    <>
      <button
        className="dm-phone-button"
        onClick={() => setOpen(!open)}
        aria-label="휴대폰 열기"
      >
        ☎
      </button>

      {open && (
        <aside className="dm-phone-panel">
          <header className="dm-phone-header">
            <strong>MESSAGES</strong>
            <button onClick={() => setOpen(false)}>×</button>
          </header>

          <label className="dm-label">AU</label>
          <select value={au} onChange={e => {
            setAu(e.target.value);
            setContact("캐릭터 A");
            setMessages([]);
          }}>
            <option>현대 AU</option>
            <option>판타지 AU</option>
          </select>

          <div className="dm-contacts">
            {["캐릭터 A", "캐릭터 B"].map(name => (
              <button
                key={name}
                className={contact === name ? "selected" : ""}
                onClick={() => {
                  setContact(name);
                  setMessages([]);
                }}
              >
                👤 {name}
              </button>
            ))}
          </div>

          <div className="dm-chat-title">{contact}</div>

          <div className="dm-messages">
            {messages.map((m, i) => (
              <div key={i} className={m.mine ? "dm-mine" : "dm-theirs"}>
                {m.text}
              </div>
            ))}
          </div>

          <form className="dm-compose" onSubmit={e => {
            e.preventDefault();
            if (!message.trim()) return;
            setMessages(prev => [...prev, {
              text: message.trim(),
              mine: true
            }]);
            setMessage("");
          }}>
            <input
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="메시지 입력..."
            />
            <button type="submit">전송</button>
          </form>
        </aside>
      )}
    </>
  );
}
