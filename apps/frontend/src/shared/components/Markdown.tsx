import ChatMessageRenderer from '../chat-parser/ChatMessageRenderer.js';

export default function Markdown({
  children,
  reasoning,
  className = '',
  asWritten = false,
}: {
  children: string;
  reasoning?: string;
  className?: string;
  asWritten?: boolean;
}) {
  return (
    <div className={`kmd ${className}`}>
      <ChatMessageRenderer content={children} reasoning={reasoning} asWritten={asWritten} />
    </div>
  );
}
