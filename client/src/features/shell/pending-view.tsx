// Shown between loading the page and the bridge's first answer, so neither the sign-in form nor the
// app flashes up for someone who is about to see the other one.
export function PendingSessionView() {
  return (
    <div class="stack">
      <h1>Chatter</h1>
      <p role="status">Checking your session</p>
    </div>
  );
}
