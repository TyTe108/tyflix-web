// The chevron in the app's Back pill.
//
// The title page's Back controls and the player's Back both render this.
// It's aria-hidden because the text "Back" names the control.
export function BackIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}
