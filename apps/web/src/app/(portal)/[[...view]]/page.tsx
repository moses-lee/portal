import { notFound } from "next/navigation";

export const metadata = { title: "Palace" };

export function generateStaticParams(): { view: string[] }[] {
  return [{ view: [] }];
}

/** Home opens Palace. Non-session screens and Agent have no standalone routes. */
export default async function PortalRoute({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params;
  if (view?.length) notFound();
  return null;
}
