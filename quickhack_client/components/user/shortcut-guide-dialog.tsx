"use client";

import { Keyboard } from "lucide-react";
import { DialogFrame } from "@/quickhack_client/components/ui/dialog-frame";
import {
  COMMON_SHORTCUT_ACTION_CODES,
  CURRENT_GROUP_SHORTCUT_ACTION_CODES,
  TOP_LEVEL_SHORTCUT_ACTION_CODES,
  type ShortcutActionCode,
  type UserShortcutBinding,
} from "@/quickhack_shared/user/personal-settings";
import {
  formatShortcutBinding,
  SHORTCUT_ACTION_LABELS,
} from "@/quickhack_client/components/user/shortcut-presenter";

type ShortcutGuideDialogProps = {
  bindings: UserShortcutBinding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const GUIDE_SECTIONS: ReadonlyArray<{
  title: string;
  actionCodes: ReadonlyArray<ShortcutActionCode>;
}> = [
  { title: "공통 작업", actionCodes: COMMON_SHORTCUT_ACTION_CODES },
  { title: "상위 메뉴 이동", actionCodes: TOP_LEVEL_SHORTCUT_ACTION_CODES },
  {
    title: "현재 메뉴 하위 이동",
    actionCodes: CURRENT_GROUP_SHORTCUT_ACTION_CODES,
  },
];

export function ShortcutGuideDialog({
  bindings,
  open,
  onOpenChange,
}: ShortcutGuideDialogProps) {
  const bindingByAction = new Map(
    bindings.map((binding) => [binding.actionCode, binding])
  );

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title="단축키 안내"
      description="현재 계정에 저장된 단축키입니다."
      icon={<Keyboard className="size-5 text-primary" />}
      headerClassName="h-14 items-center py-0"
      descriptionClassName="mt-0 text-xs"
    >
      <div className="grid gap-4 md:grid-cols-2">
              {GUIDE_SECTIONS.map((section) => {
                const sectionBindings = section.actionCodes
                  .map((actionCode) => bindingByAction.get(actionCode))
                  .filter(
                    (binding): binding is UserShortcutBinding =>
                      Boolean(binding?.keyCode)
                  );

                if (!sectionBindings.length) {
                  return null;
                }

                return (
                  <section
                    key={section.title}
                    className="overflow-hidden rounded-md border bg-popover first:md:col-span-2"
                  >
                    <h2 className="border-b bg-secondary/30 px-4 py-2 text-xs font-semibold text-muted-foreground">
                      {section.title}
                    </h2>
                    <div className="divide-y">
                      {sectionBindings.map((binding) => (
                        <div
                          key={binding.actionCode}
                          className="flex min-h-11 items-center gap-3 px-4 py-2"
                        >
                          <span className="min-w-0 flex-1 text-sm">
                            {SHORTCUT_ACTION_LABELS[binding.actionCode]}
                          </span>
                          <kbd className="shrink-0 rounded border bg-background px-2 py-1 font-mono text-xs font-semibold shadow-sm">
                            {formatShortcutBinding(binding)}
                          </kbd>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
      </div>
    </DialogFrame>
  );
}
