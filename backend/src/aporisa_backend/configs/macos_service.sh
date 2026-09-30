# macOS system-service policy (DEVELOPMENT_PLAN.md 14.6). Sourced by scripts/macos_service.sh.
# No environment override knobs.
# Quick asset checks + model load + warmup; readiness is never implied. Measured 2026-09-30:
# load + warmup 21 s with warm page cache; a cold boot reads ~67 GiB from SSD first.
MAC_SERVICE_BACKEND_START_SECONDS=300
# launchd ExitTimeOut: drain (30 s) + worker stop (15 s) + margin.
MAC_SERVICE_BACKEND_EXIT_SECONDS=90
MAC_SERVICE_STOP_MARGIN_SECONDS=20
MAC_SERVICE_POLL_SECONDS=1
MAC_SERVICE_HEALTH_SECONDS=2
