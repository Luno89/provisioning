import ChatMessageRenderer from '../lib/chat-parser/ChatMessageRenderer.js';

export default function Markdown({
  children,
  reasoning,
  className = '',
}: {
  children: string;
  reasoning?: string;
  className?: string;
}) {
  return (
    <div className={`kmd ${className}`}>
      <ChatMessageRenderer content={children} reasoning={reasoning} />
    </div>
  );
}
