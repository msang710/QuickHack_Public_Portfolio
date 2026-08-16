"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/quickhack_client/components/ui/button";
import { cn } from "@/quickhack_shared/core/utils";

export const DialogFrameClose = Dialog.Close;

export interface DialogFrameProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  beforeBody?: React.ReactNode;
  footer?: React.ReactNode;
  closeDisabled?: boolean;
  closeLabel?: string;
  overlayClassName?: string;
  contentClassName?: string;
  headerClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
}

export function DialogFrame({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  beforeBody,
  footer,
  closeDisabled = false,
  closeLabel = "닫기",
  overlayClassName,
  contentClassName,
  headerClassName,
  titleClassName,
  descriptionClassName,
  bodyClassName,
  footerClassName,
}: DialogFrameProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/35",
            overlayClassName
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] flex max-h-[82vh] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-background shadow-xl focus:outline-none",
            contentClassName
          )}
        >
          <div
            className={cn(
              "flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4",
              headerClassName
            )}
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {icon ? <div className="shrink-0">{icon}</div> : null}
              <div className="min-w-0 flex-1">
                <Dialog.Title
                  className={cn("text-base font-semibold", titleClassName)}
                >
                  {title}
                </Dialog.Title>
                {description ? (
                  <Dialog.Description
                    className={cn(
                      "mt-1 text-sm text-muted-foreground",
                      descriptionClassName
                    )}
                  >
                    {description}
                  </Dialog.Description>
                ) : null}
              </div>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={closeDisabled}
                title={closeLabel}
                aria-label={closeLabel}
              >
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>

          {beforeBody}

          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto p-5",
              bodyClassName
            )}
          >
            {children}
          </div>

          {footer ? (
            <div
              className={cn(
                "flex shrink-0 items-center border-t px-5 py-4",
                footerClassName
              )}
            >
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
