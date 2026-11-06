import { Nav } from "@/components/nav";

// Today, Up next and Phrases share the bottom tab bar; Review is full-screen.
export default function MainLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pt-6 pb-4">{children}</div>
      <Nav />
    </>
  );
}
