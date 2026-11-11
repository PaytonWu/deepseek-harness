The **pi agent** tool lets a dsh agent hand a coding task to a pi coding-agent child, keep the child alive between tool calls, and continue the same conversation later.

Every child runs as its own pi process with its own session, model, tools, and credentials. The dsh agent starts a child with a self-contained task, receives its answer, and can then send follow-up messages, interrupt a running turn, or check status. Children keep running in the background; a child recorded before a Host restart resumes from its pi session file when messaged again.

pi's own configuration stays authoritative. The host machine needs `pi` on PATH; without it every operation fails with install guidance. Session files live under the Harness home, so removing that directory removes every pi artifact.
