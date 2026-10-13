import { handleRepoEvents } from "./events.ts";
import { createForge } from "./forge.ts";

const forge = createForge();

export default {
  fetch: forge.fetch,
  queue: handleRepoEvents,
} satisfies ExportedHandler<Env>;

export {
  ChallengeStore,
  CredentialIndex,
  CeremonyFailures,
  CredentialLabels,
  IdentityRecord,
  MemberNameRegistry,
  RateLimiter,
} from "passkey-cloudflare";

export { OperatorLog } from "../../demo/src/operator-log.ts";
export { AgentRun } from "./agent-run.ts";
export { LocalRepo } from "./local-repo.ts";
export { Person } from "./person.ts";
export { Project } from "./project.ts";
export { RepoIndex } from "./repo-index.ts";
