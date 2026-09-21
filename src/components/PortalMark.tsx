import Image from "next/image";
import { cn } from "@/lib/utils";
import portalLogo from "../../public/portal.png";

/** Portal's logo, sized with `size-*`. Defaults to the sidebar's size. */
export default function PortalMark({
  className,
}: {
  className?: string;
}) {
  return (
    <Image
      src={portalLogo}
      alt=""
      width={56}
      height={56}
      loading="eager"
      className={cn("size-7 shrink-0 rounded-full", className)}
    />
  );
}
