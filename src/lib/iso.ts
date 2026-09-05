import { countries } from "country-code-lookup";

export const NUMERIC_TO_ALPHA3: Record<string, string> = Object.fromEntries(
  countries.map((country) => [country.isoNo, country.iso3]),
);

export const ALPHA3_TO_ALPHA2: Record<string, string> = Object.fromEntries(
  countries.map((country) => [country.iso3, country.iso2]),
);

export const ALPHA2_TO_ALPHA3: Record<string, string> = Object.fromEntries(
  countries.map((country) => [country.iso2, country.iso3]),
);

const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
    : null;

function displayCountryName(iso2: string, englishName: string): string {
  return regionNames?.of(iso2) ?? englishName;
}

export const COUNTRY_OPTIONS = [
  ...[...new Map(
    countries.map((country) => [
      country.iso3,
      displayCountryName(country.iso2, country.country),
    ]),
  ).entries()]
    .map(([code, name]) => [code, name] as const)
    .sort((a, b) => a[1].localeCompare(b[1], "zh-CN")),
  ["OTHER", "其他"] as const,
];

export function countryName(code: string): string {
  return COUNTRY_OPTIONS.find(([value]) => value === code)?.[1] ?? "位置未定";
}
