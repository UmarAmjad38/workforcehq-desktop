/** Unlayered Slack layout — Electron ignores some Tailwind @layer CSS. */
export const CHAT_EMBED_CSS = `
html, body, #__next {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: #fff !important;
}
body { color: #1d1c1d !important; }
#whq-embed, #whq-embed > main, #whq-chat {
  display: flex !important;
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  overflow: hidden !important;
  background: #fff !important;
}
#whq-embed { flex-direction: column !important; }
#whq-embed > main { flex: 1 1 auto !important; flex-direction: column !important; min-height: 0 !important; }
#whq-chat {
  flex-direction: row !important;
  flex: 1 1 auto !important;
  color: #1d1c1d !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
}
#whq-chat-sidebar {
  display: flex !important;
  flex-direction: column !important;
  width: 260px !important;
  flex-shrink: 0 !important;
  background: #3F0E40 !important;
  color: #fff !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
#whq-chat-sidebar > div:first-child {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 12px 16px !important;
  border-bottom: 1px solid rgba(255,255,255,0.1) !important;
  flex-shrink: 0 !important;
}
#whq-chat-nav,
#whq-chat-sidebar .whq-dark-scroll,
#whq-chat-sidebar > div:last-child {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  padding: 12px 8px !important;
}
/* Do not set scrollbar-color — Chrome/Windows then uses the native white bar. */
#whq-chat-nav::-webkit-scrollbar,
#whq-chat-sidebar .whq-dark-scroll::-webkit-scrollbar,
#whq-chat-sidebar > div:last-child::-webkit-scrollbar {
  width: 8px !important;
  height: 8px !important;
  background: #3F0E40 !important;
}
#whq-chat-nav::-webkit-scrollbar-track,
#whq-chat-sidebar .whq-dark-scroll::-webkit-scrollbar-track,
#whq-chat-sidebar > div:last-child::-webkit-scrollbar-track {
  background: #3F0E40 !important;
  border: none !important;
}
#whq-chat-nav::-webkit-scrollbar-thumb,
#whq-chat-sidebar .whq-dark-scroll::-webkit-scrollbar-thumb,
#whq-chat-sidebar > div:last-child::-webkit-scrollbar-thumb {
  background: #a078a0 !important;
  border-radius: 8px !important;
  border: 2px solid #3F0E40 !important;
}
#whq-chat-nav::-webkit-scrollbar-thumb:hover,
#whq-chat-sidebar .whq-dark-scroll::-webkit-scrollbar-thumb:hover,
#whq-chat-sidebar > div:last-child::-webkit-scrollbar-thumb:hover {
  background: #c4a0c4 !important;
}
#whq-chat-nav::-webkit-scrollbar-button,
#whq-chat-sidebar .whq-dark-scroll::-webkit-scrollbar-button,
#whq-chat-sidebar > div:last-child::-webkit-scrollbar-button {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  background: #3F0E40 !important;
}
#whq-chat-nav::-webkit-scrollbar-corner,
#whq-chat-sidebar .whq-dark-scroll::-webkit-scrollbar-corner,
#whq-chat-sidebar > div:last-child::-webkit-scrollbar-corner {
  background: #3F0E40 !important;
}
#whq-chat-sidebar button.whq-channel-row {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  width: 100% !important;
  text-align: left !important;
  border: 0 !important;
  color: #fff !important;
  padding: 6px 8px 6px 16px !important;
  border-radius: 6px !important;
  cursor: pointer !important;
  font-size: 15px !important;
}
#whq-chat-sidebar .whq-side-heading {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: space-between !important;
  width: 100% !important;
}
#whq-chat-sidebar .whq-side-add {
  width: 24px !important;
  height: 24px !important;
  flex: 0 0 auto !important;
  padding: 0 !important;
}
#whq-chat-main {
  display: flex !important;
  flex-direction: column !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  min-height: 0 !important;
  width: auto !important;
  background: #fff !important;
  position: relative !important;
}
#whq-chat-main > header {
  display: flex !important;
  align-items: center !important;
  height: 48px !important;
  flex-shrink: 0 !important;
  border-bottom: 1px solid #e8e8e8 !important;
  padding: 0 16px !important;
  gap: 8px !important;
}
#whq-chat-msgs {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  background: #fff !important;
  padding: 8px 0 !important;
}
#whq-chat-composer {
  flex-shrink: 0 !important;
  padding: 8px 16px 16px !important;
  background: #fff !important;
}
#whq-composer-box {
  display: flex !important;
  flex-direction: column !important;
  border: 1px solid #868686 !important;
  border-radius: 8px !important;
  overflow: hidden !important;
  background: #fff !important;
}
#whq-chat-composer textarea,
#whq-composer-box textarea {
  display: block !important;
  width: 100% !important;
  min-height: 56px !important;
  border: 0 !important;
  outline: none !important;
  resize: none !important;
  font-size: 15px !important;
  line-height: 1.4 !important;
  padding: 10px 12px !important;
  background: #fff !important;
  color: #1d1c1d !important;
  box-sizing: border-box !important;
}
#whq-composer-tools {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 4px !important;
  border-top: 1px solid #eee !important;
  padding: 4px !important;
  background: #fff !important;
}
#whq-composer-tools label,
#whq-composer-tools > div,
#whq-composer-tools button {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: auto !important;
  flex: 0 0 auto !important;
  margin: 0 !important;
  padding: 6px !important;
  border: 0 !important;
  background: transparent !important;
  cursor: pointer !important;
}
#whq-composer-tools > button:last-child {
  margin-left: auto !important;
  background: #007a5a !important;
  color: #fff !important;
  border-radius: 6px !important;
}
#whq-chat input[type="file"] {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  opacity: 0 !important;
}
#whq-chat .whq-msg {
  display: flex !important;
  gap: 8px !important;
  padding: 3px 20px !important;
  position: relative !important;
}
#whq-chat .whq-msg-meta {
  display: flex !important;
  align-items: baseline !important;
  gap: 8px !important;
  flex-wrap: wrap !important;
}
#whq-chat .whq-msg-actions {
  display: none !important;
  position: absolute !important;
  top: -12px !important;
  right: 12px !important;
  z-index: 6 !important;
  flex-direction: row !important;
  align-items: center !important;
  background: #fff !important;
  border: 1px solid #e8e8e8 !important;
  border-radius: 8px !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12) !important;
  padding: 2px !important;
  width: auto !important;
}
#whq-chat .whq-msg:hover .whq-msg-actions,
#whq-chat .whq-msg-actions.is-open {
  display: flex !important;
}
#whq-thread {
  display: flex !important;
  flex-direction: column !important;
  width: 360px !important;
  flex-shrink: 0 !important;
  height: 100% !important;
  min-height: 0 !important;
  background: #fff !important;
  border-left: 1px solid #e8e8e8 !important;
}
@keyframes whqspin {
  to { transform: rotate(360deg); }
}
.whq-modal label {
  display: block !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  color: #334155 !important;
  margin: 0 0 6px !important;
}
.whq-modal input,
.whq-modal select,
.whq-modal textarea {
  display: block !important;
  width: 100% !important;
  box-sizing: border-box !important;
  height: 40px !important;
  border: 1px solid #cbd5e1 !important;
  border-radius: 8px !important;
  padding: 0 12px !important;
  font-size: 14px !important;
  margin-bottom: 12px !important;
  background: #fff !important;
}
.whq-modal > div:last-child button {
  background: #3F0E40 !important;
  color: #fff !important;
}
.whq-react-tip {
  position: relative !important;
  display: inline-flex !important;
}
.whq-react-tip-box {
  display: none !important;
  position: absolute !important;
  left: 50% !important;
  bottom: calc(100% + 6px) !important;
  transform: translateX(-50%) !important;
  background: #1d1c1d !important;
  color: #fff !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  line-height: 1.35 !important;
  padding: 6px 8px !important;
  border-radius: 6px !important;
  white-space: nowrap !important;
  z-index: 30 !important;
  max-width: 240px !important;
  white-space: normal !important;
  width: max-content !important;
}
.whq-react-tip:hover .whq-react-tip-box {
  display: block !important;
}
#whq-chat .whq-msg-actions button {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: auto !important;
  min-width: 28px !important;
  height: 28px !important;
  padding: 0 6px !important;
  margin: 0 !important;
  border: 0 !important;
  background: transparent !important;
  cursor: pointer !important;
  font-size: 14px !important;
}
#whq-chat .whq-msg-actions button:hover {
  background: #f8f8f8 !important;
  border-radius: 6px !important;
}
`;
