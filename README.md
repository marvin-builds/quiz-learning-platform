# Quiz learning platform

A personal sandbox project in which I test what current AI engineering can do
and learn agentic development workflows hands-on.

It is built with a test-gated, multi-agent Claude Code workflow: hook-enforced
quality gates, role-restricted subagents, and an orchestrator that runs issues
in parallel in isolated git worktrees, each with its own database stack. The
harness is tested, and the ADRs record what it measured.

Since the point is to see how far the agents get on their own, the AI-written
code here is not read line by line; it rests on the automated gates, the tests
and agent reviews.

The project itself is a free, non-commercial learning platform:
multiple-choice quizzes in categories, played anonymously or with an account,
and managed by admins in the same app. It runs on the web, Android and iOS
(Expo) with Supabase as the backend, and is built test-first with Claude Code
as the main implementer.

Start with [`CLAUDE.md`](CLAUDE.md) for the commands, layout and rules, and
[`docs/plan/`](docs/plan/) for the scope, architecture and implementation plan.

Licensed under the [GNU AGPL v3](LICENSE).
