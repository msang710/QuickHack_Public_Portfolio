// QuickHack note: 메뉴 페이지와 목록 패널의 높이, 스크롤, 테두리 구조를 공통으로 유지합니다.
import * as React from "react";
import { cn } from "@/quickhack_shared/core/utils";

export type WorkspacePageFrameProps = React.HTMLAttributes<HTMLElement>;

export function WorkspacePageFrame({
  className,
  children,
  ...props
}: WorkspacePageFrameProps) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden",
        className
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export interface WorkspacePanelProps
  extends React.HTMLAttributes<HTMLElement> {
  as?: "div" | "aside" | "section";
}

export function WorkspacePanel({
  as = "div",
  className,
  children,
  ...props
}: WorkspacePanelProps) {
  const Component: React.ElementType = as;

  return (
    <Component
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-md border bg-popover",
        className
      )}
      {...props}
    >
      {children}
    </Component>
  );
}

export type PanelToolbarProps = React.HTMLAttributes<HTMLDivElement>;

export function PanelToolbar({
  className,
  children,
  ...props
}: PanelToolbarProps) {
  return (
    <div
      className={cn("grid shrink-0 gap-3 border-b p-3", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface MasterDetailLayoutProps
  extends React.HTMLAttributes<HTMLElement> {
  as?: "div" | "section";
}

export function MasterDetailLayout({
  as = "div",
  className,
  children,
  ...props
}: MasterDetailLayoutProps) {
  const Component: React.ElementType = as;

  return (
    <Component
      className={cn("grid min-h-0 flex-1", className)}
      {...props}
    >
      {children}
    </Component>
  );
}
