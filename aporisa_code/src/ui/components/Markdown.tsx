// Markdown for agent messages: GFM through react-markdown (React elements, no innerHTML).
// Inline code renders as a pill; code blocks are monospaced without highlighting (MVP).
// Links open in the default browser (the main process denies in-app navigation).
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ className, children }) => <code className={className ?? "inline-code"}>{children}</code>,
  pre: ({ children }) => <pre className="code-block">{children}</pre>,
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
