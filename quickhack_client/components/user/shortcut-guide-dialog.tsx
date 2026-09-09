"use client";

import { Keyboard } from "lucide-react";
import { useTranslations } from "next-intl";
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
  SHORTCUT_ACTION_MESSAGE_KEYS,
  SHORTCUT_MODIFIER_MESSAGE_KEYS,
} from "@/quickhack_client/components/user/shortcut-presenter";

type ShortcutGuideDialogProps = {
  bindings: UserShortcutBinding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const GUIDE_SECTIONS: ReadonlyArray<{
  titleKey: "common" | "top" | "current";
  actionCodes: ReadonlyArray<ShortcutActionCode>;
}> = [
  { titleKey: "common", actionCodes: COMMON_SHORTCUT_ACTION_CODES },
  { titleKey: "top", actionCodes: TOP_LEVEL_SHORTCUT_ACTION_CODES },
  {
    titleKey: "current",
    actionCodes: CURRENT_GROUP_SHORTCUT_ACTION_CODES,
  },
];

export function ShortcutGuideDialog({
  bindings,
  open,
  onOpenChange,
}: ShortcutGuideDialogProps) {
  const t = useTranslations("settings.personal.shortcuts");
  const bindingByAction = new Map(
    bindings.map((binding) => [binding.actionCode, binding])
  );

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title={t("guide.title")}
      description={t("guide.description")}
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
                    key={section.titleKey}
                    className="overflow-hidden rounded-md border bg-popover first:md:col-span-2"
                  >
                    <h2 className="border-b bg-secondary/30 px-4 py-2 text-xs font-semibold text-muted-foreground">
                      {t(`guide.sections.${section.titleKey}`)}
                    </h2>
                    <div className="divide-y">
                      {sectionBindings.map((binding) => (
                        <div
                          key={binding.actionCode}
                          className="flex min-h-11 items-center gap-3 px-4 py-2"
                        >
                          <span className="min-w-0 flex-1 text-sm">
                            {t(`action.${SHORTCUT_ACTION_MESSAGE_KEYS[binding.actionCode]}`)}
                          </span>
                          <kbd className="shrink-0 rounded border bg-background px-2 py-1 font-mono text-xs font-semibold shadow-sm">
                            {formatShortcutBinding(binding, {
                              unset: t("unassigned"),
                              modifier: (modifier) =>
                                t(`modifiers.${SHORTCUT_MODIFIER_MESSAGE_KEYS[modifier]}`),
                            })}
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
