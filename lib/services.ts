export const SMS_SERVICE_OPTIONS = [
  {
    id: "soulapp",
    label: "SoulAPP",
    description: "香港号码",
  },
] as const;

export type SmsServiceKey = (typeof SMS_SERVICE_OPTIONS)[number]["id"];

export function findSmsService(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SMS_SERVICE_OPTIONS.find((service) => service.id === normalized);
}

export function defaultSmsService() {
  return SMS_SERVICE_OPTIONS[0];
}
