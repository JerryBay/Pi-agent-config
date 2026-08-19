# Windows Notify

Global Pi extension for Windows completion notifications.

- Uses `agent_settled`, so retries, compaction retries, and queued follow-ups produce one final notification.
- Default `away` mode suppresses notifications while the current Windows Terminal tab is focused.
- Uses DECSET 1004 focus reports when available and a native foreground-window check as fallback.
- Sends through the registered Windows Terminal Preview/Stable App ID, falling back to Windows PowerShell. Set `PI_NOTIFY_APP_ID` to override the sender.
- Uses background activation for the toast body so clicking it dismisses the notification without opening a new terminal window.
- Toast text contains only project/session status and elapsed time.

Commands:

- `/notify status`
- `/notify test`
- `/notify on`
- `/notify off`
- `/notify away`
- `/notify always`

Launch flags:

- `--notify-disable`
- `--notify-always`

Command changes are session-local. New sessions default to `away` mode unless a launch flag overrides it.
