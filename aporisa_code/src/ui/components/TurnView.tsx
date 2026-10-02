// One turn, after the user's ChatGPT.app screenshots (DEVELOPMENT_PLAN.md 10.4): the final
// answer stays visible; the process sits behind "Worked for …"; consecutive tool calls are
// one activity line that expands into rows, and a row into a shell or patch panel.
import { BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileImage, FolderTree, Keyboard, ListChecks, Loader, Minimize2, Pencil, Search, ShieldOff, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ServerRequest, Turn } from "../../app-protocol/types.ts";
import { useUi } from "../context.tsx";
import { formatDuration, formatTokens, type MessageKey } from "../i18n.ts";
import { activityRows, filePatch, layoutTurn, patchLines, summarize, turnDuration, type ActivityRow, type ProcessBlock, type ToolItem } from "../state/turn-layout.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Markdown } from "./Markdown.tsx";

/** Re-renders every second while `active`, for live timers. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Disclosure({ open }: { open: boolean }) {
  return open ? <ChevronDown size={14} className="chevron" /> : <ChevronRight size={14} className="chevron" />;
}

function CopyButton({ text }: { text: string }) {
  const { t } = useUi();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button small"
      title={copied ? t("copied") : t("copy")}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function ShellPanel({ item }: { item: Extract<ToolItem, { type: "commandExecution" | "stdinInteraction" }> }) {
  const header = item.type === "commandExecution" ? `$ ${item.command}` : item.chars === "" ? "" : `> ${JSON.stringify(item.chars)}`;
  const text = [header, item.output].filter((part) => part !== "").join("\n");
  return (
    <div className="panel">
      <div className="panel-bar">
        <span>Shell</span>
        <CopyButton text={text} />
      </div>
      <pre className="panel-body">
        {header && <span className="panel-command">{header}</span>}
        {header && item.output ? "\n" : ""}
        {item.output}
      </pre>
    </div>
  );
}

function PatchPanel({ patch }: { patch: string }) {
  return (
    <div className="panel">
      <div className="panel-bar">
        <span>Patch</span>
        <CopyButton text={patch} />
      </div>
      <pre className="panel-body">
        {patchLines(patch).map((line, index) => (
          <span key={index} className={`patch-${line.role}`}>
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

const ROW_ICONS: Record<ActivityRow["kind"], typeof BookOpen> = {
  read: BookOpen,
  search: Search,
  searchIn: Search,
  list: FolderTree,
  listIn: FolderTree,
  run: SquareTerminal,
  add: Pencil,
  update: Pencil,
  delete: Pencil,
  move: Pencil,
  stdin: Keyboard,
  poll: Keyboard,
  image: FileImage,
  tool: Wrench,
};

function RowStatus({ item }: { item: ToolItem }) {
  const { t } = useUi();
  const notes: ReactNode[] = [];
  if (item.status === "running") notes.push(<Loader key="running" size={12} className="spin" />);
  if (item.type === "commandExecution") {
    if (item.status !== "running" && item.sessionId !== null) notes.push(<span key="bg">{t("status.background", { id: item.sessionId })}</span>);
    if (item.exitCode !== null && item.exitCode !== 0) notes.push(<span key="exit">{t("status.exit", { code: item.exitCode })}</span>);
    if (item.sandboxed === false) notes.push(<span key="outside" className="badge-outside" title={t("status.outside")}><ShieldOff size={11} /></span>);
  }
  if (item.status === "declined") notes.push(<span key="declined">{t("status.declined")}</span>);
  else if (item.status === "failed" && !(item.type === "commandExecution" && item.exitCode !== null)) notes.push(<span key="failed">{t("status.failed")}</span>);
  return notes.length > 0 ? <span className="row-status">{notes}</span> : null;
}

function ActivityRowView({ row }: { row: ActivityRow }) {
  const { t } = useUi();
  const [open, setOpen] = useState(false);
  const Icon = ROW_ICONS[row.kind];
  const label = t(`row.${row.kind}` as MessageKey, row.values);
  const expandable = row.detail !== null;
  return (
    <div className="activity-row-wrap">
      <button type="button" className={`activity-row${expandable ? "" : " static"}`} onClick={() => expandable && setOpen((value) => !value)}>
        <Icon size={14} className="row-icon" />
        <span className="row-label">{label}</span>
        <RowStatus item={row.item} />
        {expandable && <Disclosure open={open} />}
      </button>
      {open && row.detail === "shell" && (row.item.type === "commandExecution" || row.item.type === "stdinInteraction") && <ShellPanel item={row.item} />}
      {open && row.detail === "output" && (row.item.type === "stdinInteraction" ? <ShellPanel item={row.item} /> : row.item.type === "toolCall" ? <pre className="panel-body standalone">{row.item.output}</pre> : null)}
      {open && row.detail === "patch" && row.item.type === "fileChange" && (row.item.message ? <pre className="panel-body standalone">{row.item.message}</pre> : <PatchPanel patch={filePatch(row.item.patch, row.values.path ?? "")} />)}
    </div>
  );
}

function ActivityGroup({ items }: { items: ToolItem[] }) {
  const { t, language } = useUi();
  const [open, setOpen] = useState(false);
  const parts = summarize(items);
  const joined = parts.map((part) => t(`activity.${part}` as MessageKey)).join(language === "zh-CN" ? "，" : ", ");
  const label = language === "zh-CN" ? joined : joined.charAt(0).toUpperCase() + joined.slice(1);
  const running = items.some((item) => item.status === "running");
  const first = items[0];
  const Icon = first?.type === "fileChange" ? Pencil : first?.type === "commandExecution" && first.actions.every((action) => action.kind === "read") ? BookOpen : SquareTerminal;
  return (
    <div className="activity">
      <button type="button" className="activity-summary" onClick={() => setOpen((value) => !value)}>
        {running ? <Loader size={14} className="spin row-icon" /> : <Icon size={14} className="row-icon" />}
        <span>{label}</span>
        <Disclosure open={open} />
      </button>
      {open && (
        <div className="activity-rows">
          {activityRows(items).map((row) => (
            <ActivityRowView key={row.key} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThoughtRow({ block }: { block: Extract<ProcessBlock, { kind: "thought" }> }) {
  const { t, language } = useUi();
  const [open, setOpen] = useState(false);
  const running = block.item.status === "running";
  const label = running || block.item.durationMs === null ? (running ? t("thinking") : t("thoughtFor", { duration: "…" })) : t("thoughtFor", { duration: formatDuration(block.item.durationMs, language) });
  return (
    <div className="thought">
      <button type="button" className="activity-summary" onClick={() => setOpen((value) => !value)}>
        {running && <Loader size={14} className="spin row-icon" />}
        <span>{label}</span>
        <Disclosure open={open} />
      </button>
      {open && <div className="thought-text">{block.item.text}</div>}
    </div>
  );
}

function PlanCard({ block }: { block: Extract<ProcessBlock, { kind: "plan" }> }) {
  const { t } = useUi();
  return (
    <div className="plan">
      <div className="plan-title">
        <ListChecks size={14} />
        <span>{t("plan")}</span>
      </div>
      {block.item.explanation && <p className="plan-explanation">{block.item.explanation}</p>}
      <ul>
        {block.item.plan.map((step, index) => (
          <li key={index} className={`plan-step ${step.status}`}>
            <span className="plan-mark">{step.status === "completed" ? "✓" : step.status === "in_progress" ? "›" : "○"}</span>
            {step.step}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CompactionRow({ block }: { block: Extract<ProcessBlock, { kind: "compaction" }> }) {
  const { t, language } = useUi();
  const item = block.item;
  const label =
    item.status === "running"
      ? t("compacting")
      : item.status === "failed"
        ? t("compactionFailed")
        : item.tokensAfter !== null && item.tokensBefore > 0
          ? t("compacted", { before: formatTokens(item.tokensBefore, language), after: formatTokens(item.tokensAfter, language) })
          : t("compactedShort");
  return (
    <div className="compaction">
      {item.status === "running" ? <Loader size={14} className="spin" /> : <Minimize2 size={14} />}
      <span>{label}</span>
    </div>
  );
}

function ProcessBlocks({ blocks }: { blocks: ProcessBlock[] }) {
  return (
    <div className="process">
      {blocks.map((block) => {
        switch (block.kind) {
          case "message":
            return <Markdown key={block.id} className="commentary" text={block.item.text} />;
          case "thought":
            return <ThoughtRow key={block.id} block={block} />;
          case "activity":
            return <ActivityGroup key={block.id} items={block.items} />;
          case "plan":
            return <PlanCard key={block.id} block={block} />;
          case "compaction":
            return <CompactionRow key={block.id} block={block} />;
        }
      })}
    </div>
  );
}

export function TurnView({ turn, approvals }: { turn: Turn; approvals: ServerRequest[] }) {
  const { t, language } = useUi();
  const layout = layoutTurn(turn);
  const running = turn.status === "running";
  const now = useNow(running);
  const [choice, setChoice] = useState<boolean | null>(null);
  // Running: open; finished with an answer: closed; failed or interrupted: open (no answer to read).
  const open = choice ?? (running || layout.answer === null);
  const duration = formatDuration(turnDuration(turn, now), language);
  const onlyCompaction = layout.user === null && layout.process.every((block) => block.kind === "compaction");

  if (onlyCompaction) {
    return (
      <section className="turn">
        <ProcessBlocks blocks={layout.process} />
      </section>
    );
  }

  return (
    <section className="turn">
      {layout.user && (
        <div className="user-message">
          {layout.user.images.length > 0 && (
            <div className="user-images">
              {layout.user.images.map((image, index) => (
                <img key={index} src={image} alt="" />
              ))}
            </div>
          )}
          {layout.user.text && <div className="user-text">{layout.user.text}</div>}
        </div>
      )}
      {(layout.process.length > 0 || running) && (
        <div className="worked">
          <button type="button" className="worked-toggle" onClick={() => setChoice(!open)}>
            <span>{running ? t("working", { duration }) : t("workedFor", { duration })}</span>
            <Disclosure open={open} />
          </button>
          {open && <ProcessBlocks blocks={layout.process} />}
        </div>
      )}
      {approvals.map((request) => (
        <ApprovalCard key={request.id} request={request} />
      ))}
      {layout.answer && <Markdown className="answer" text={layout.answer.text} />}
      {turn.truncated && <div className="turn-note">{t("answerCut")}</div>}
      {turn.status === "interrupted" && <div className="turn-note">{t("interrupted")}</div>}
      {turn.status === "failed" && (
        <div className="turn-error">
          <CircleAlert size={14} />
          <span>{t("turnFailed", { message: turn.error?.message ?? turn.error?.code ?? "" })}</span>
        </div>
      )}
    </section>
  );
}
