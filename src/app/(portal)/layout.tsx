import Chat from "@/components/Chat";

/**
 * The whole app is one client component that reads the session from the URL, so it lives in the
 * layout and stays mounted while navigation between `/` and `/sessions/[id]` only changes the path.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Chat />
      {children}
    </>
  );
}
