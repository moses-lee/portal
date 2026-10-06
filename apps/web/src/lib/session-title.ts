/** The name a session shows everywhere (the sidebar's vocabulary): its title, or "New conversation" without one. */
export function sessionDisplayTitle(title: string | null | undefined): string {
  return title || "New conversation";
}
