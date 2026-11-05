// The iPhone home-screen icon (180×180, full bleed: iOS rounds the corners itself).
import { ImageResponse } from "next/og";
import { BambooMark } from "@/components/bamboo-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<BambooMark width={180} height={180} />, size);
}
