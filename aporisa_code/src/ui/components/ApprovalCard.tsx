// An approval question (F3 decisions: approved / approved_for_session / denied), shown below
// the turn's process so a collapsed process cannot hide it.
import { ShieldAlert } from "lucide-react";
import type { ApprovalDecision, ServerRequest } from "../../app-protocol/types.ts";
import { useUi } from "../context.tsx";
import type { MessageKey } from "../i18n.ts";

export function ApprovalCard({ request }: { request: ServerRequest }) {
  const { bridge, dispatch, t } = useUi();
  const question = request.params.request;
  const answer = (decision: ApprovalDecision) => {
    bridge.respond(request.id, { decision });
    dispatch({ type: "approval/answered", id: request.id });
  };
  const title = question.kind === "command" ? t(`approval.${question.reason}` as MessageKey) : t(`approval.patch.${question.reason}` as MessageKey);
  const remember = question.kind === "command" ? question.rememberPrefixes?.map((prefix) => prefix.join(" ")).join(", ") : null;
  return (
    <div className="approval">
      <div className="approval-title">
        <ShieldAlert size={16} />
        <span>{title}</span>
      </div>
      {question.kind === "command" && question.justification && <p className="approval-justification">{question.justification}</p>}
      {question.kind === "command" ? (
        <pre className="approval-command">$ {question.command}</pre>
      ) : (
        <ul className="approval-paths">
          {question.paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
      {question.kind === "command" && question.sandboxed && <p className="hint">{t("approval.inSandbox")}</p>}
      <div className="approval-actions">
        <button type="button" className="primary" onClick={() => answer("approved")}>
          {t("approval.allowOnce")}
        </button>
        {question.kind === "command" && remember && (
          <button type="button" onClick={() => answer("approved_for_session")}>
            {t("approval.allowSession", { prefix: remember })}
          </button>
        )}
        {question.kind === "patch" && (
          <button type="button" onClick={() => answer("approved_for_session")}>
            {t("approval.allowPathsSession")}
          </button>
        )}
        <button type="button" className="danger" onClick={() => answer("denied")}>
          {t("approval.deny")}
        </button>
      </div>
    </div>
  );
}
