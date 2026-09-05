import { describe, expect, it } from "vitest";
import { countryCodeForProvider, parseProviderResults } from "../src/lib/geocode";

describe("place geocoding", () => {
  it("converts the stored ISO alpha-3 country to the provider filter", () => {
    expect(countryCodeForProvider("CHN")).toBe("cn");
    expect(countryCodeForProvider("DEU")).toBe("de");
    expect(countryCodeForProvider("UNK")).toBeNull();
    expect(countryCodeForProvider("OTHER")).toBeNull();
  });

  it("normalizes a provider response into coordinates used by a globe pin", () => {
    expect(
      parseProviderResults([
        {
          lat: "26.074286",
          lon: "119.296411",
          display_name: "福州市, 福建省, 中国",
          address: { country_code: "cn" },
        },
      ]),
    ).toEqual({
      found: true,
      lat: 26.074286,
      lng: 119.296411,
      displayName: "福州市, 福建省, 中国",
      country: "CHN",
    });
  });

  it("does not accept malformed or out-of-range provider coordinates", () => {
    expect(parseProviderResults([{ lat: "200", lon: "119" }])).toEqual({
      found: false,
    });
    expect(parseProviderResults([])).toEqual({ found: false });
  });
});
