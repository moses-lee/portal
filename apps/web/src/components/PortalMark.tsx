import Image from "next/image";
import { cn } from "@/lib/utils";
import palaceLogo from "../../public/palace-logo.png";

/** Portal's logo, sized with `size-*`. Defaults to the sidebar's size. */
export default function PortalMark({
  className,
}: {
  className?: string;
}) {
  return (
    <Image
      src={palaceLogo}
      alt=""
      width={56}
      height={56}
      loading="eager"
      className={cn("size-7 shrink-0 scale-[1.4] object-contain", className)}
    />
  );
}
