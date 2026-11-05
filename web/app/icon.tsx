// PNG icons for the favicon and the PWA manifest (served at /icon/192 and /icon/512).
import { ImageResponse } from "next/og";
import { BambooMark } from "@/components/bamboo-mark";

const ICON_SIZES = [192, 512] as const;

export function generateImageMetadata() {
  return ICON_SIZES.map((size) => ({
    id: String(size),
    size: { width: size, height: size },
    contentType: "image/png",
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const size = Number(await id);
  return new ImageResponse(<BambooMark width={size} height={size} />, {
    width: size,
    height: size,
  });
}
