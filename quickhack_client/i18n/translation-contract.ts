export type TranslationPrimitive = string | number | Date;
export type TranslationValues = Readonly<Record<string, TranslationPrimitive>>;

/**
 * Pure presenters and column builders receive this dependency explicitly.
 * React components should obtain it from useTranslations(namespace); module
 * scope business definitions must store semantic keys instead of translated text.
 */
export type MessageTranslator<Key extends string = string> = (
  key: Key,
  values?: TranslationValues
) => string;

export type LocalizedOption<Value extends string = string> = Readonly<{
  value: Value;
  labelKey: string;
}>;

export function presentLocalizedOptions<Value extends string>(
  options: readonly LocalizedOption<Value>[],
  translate: MessageTranslator
) {
  return options.map((option) => ({
    value: option.value,
    label: translate(option.labelKey),
  }));
}
