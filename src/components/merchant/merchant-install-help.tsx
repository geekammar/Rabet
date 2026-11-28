import type { MerchantLocale } from "@/lib/merchant/locale";

const COPY = {
  ar: {
    title: "أضف نكمل للشاشة الرئيسية",
    android: "على Android، افتح قائمة Chrome واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».",
    iphone: "على iPhone، افتح قائمة المشاركة في Safari واختر «إضافة إلى الشاشة الرئيسية».",
  },
  en: {
    title: "Add Nokmel to your home screen",
    android: "On Android, open Chrome’s menu and choose Install app or Add to Home screen.",
    iphone: "On iPhone, open Safari’s Share menu and choose Add to Home Screen.",
  },
};

export function MerchantInstallHelp({ locale }: { locale: MerchantLocale }) {
  const copy = COPY[locale];

  return (
    <details
      className="rounded-xl border border-border bg-card px-4 [@media(display-mode:standalone)]:hidden"
      data-testid="merchant-install-help"
    >
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
        {copy.title}
      </summary>
      <div className="space-y-2 pb-4 text-sm text-muted-foreground">
        <p>{copy.android}</p>
        <p>{copy.iphone}</p>
      </div>
    </details>
  );
}
