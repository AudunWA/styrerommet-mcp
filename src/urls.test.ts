import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInvoiceWebUrl,
  buildSupplierWebUrl,
  buildMeetingWebUrl,
  buildArchiveWebUrl,
  buildCantorReportWebUrl,
  buildCantorHomeWebUrl,
  buildVibboWebUrl,
  buildGeneralAssemblyWebUrl,
  buildEconomyWebUrl,
  buildHmsWebUrl,
  buildTasksWebUrl,
  buildMittByggWebUrl,
  buildMittByggMaintenancePlanWebUrl,
  buildMittByggConditionWebUrl,
  buildMittByggBuildingPartWebUrl,
  buildMittByggTasksWebUrl,
  buildMittByggDocumentsWebUrl,
  buildMittByggCompanyWebUrl,
  buildMittByggConditionReportWebUrl,
} from "./urls.ts";

describe("MCP Resource URL Builders", () => {
  it("builds correct invoice web URL using a sample ID", () => {
    const rawInvoiceId = "SW52b2ljZToxMjM0NQ==";
    const url = buildInvoiceWebUrl(rawInvoiceId, "12345");
    assert.equal(
      url,
      "https://styrerommet.no/12345/okonomi?referrer=shortcuts&invoice=SW52b2ljZToxMjM0NQ%3D%3D&organizationNumber=12345",
    );
  });

  it("builds correct supplier web URL using a sample ID", () => {
    const supplierId = "U3VwcGxpZXI6MTIzNDU=";
    const url = buildSupplierWebUrl(supplierId, "12345");
    assert.equal(
      url,
      "https://styrerommet.no/12345/leverandorer/leverandor/U3VwcGxpZXI6MTIzNDU%3D",
    );
  });

  it("builds correct meeting web URL using a sample ID", () => {
    const meetingId = "TWVldGluZzoxMjM0NQ==";
    const url = buildMeetingWebUrl(meetingId, "12345");
    assert.equal(
      url,
      "https://styrerommet.no/12345/styremoter/mote/TWVldGluZzoxMjM0NQ%3D%3D",
    );
  });

  it("builds correct archive web URL using a sample ID with spaces and parentheses", () => {
    const archivePath =
      "/resources/12345/Safety/Example contract (North Street 10)/Alarm agreement.pdf";
    const url = buildArchiveWebUrl(archivePath, "12345");
    assert.equal(
      url,
      "https://arkiv.styrerommet.no/web/12345/styre/filer/Safety/Example%20contract%20(North%20Street%2010)/Alarm%20agreement.pdf",
    );
  });

  it("builds archive URL for folder root and sibling archives", () => {
    assert.equal(
      buildArchiveWebUrl("/resources/12345", "12345"),
      "https://arkiv.styrerommet.no/web/12345/styre/filer",
    );
    assert.equal(
      buildArchiveWebUrl(
        "/resources/12345-arkiv/Protokoller/2026.pdf",
        "12345",
      ),
      "https://arkiv.styrerommet.no/web/12345-arkiv/styre/filer/Protokoller/2026.pdf",
    );
  });

  it("builds correct Cantor dynamic report URL using a sample ID", () => {
    const url = buildCantorReportWebUrl(251, "12345");
    assert.equal(
      url,
      "https://cws.obos.no/dynamicreport/251?fnr=12345&list=off",
    );
  });

  it("builds Cantor SSO redirect URL", () => {
    const url = buildCantorHomeWebUrl("12345");
    assert.equal(
      url,
      "https://styrerommet.no/redirect/cantor?obosCompanyNumber=12345",
    );
  });

  it("builds Vibbo resource URLs for news, topics, threads, and events", () => {
    assert.equal(
      buildVibboWebUrl("nyheter", "dugnad-varen-2026", "example-coop"),
      "https://vibbo.no/example-coop/nyheter/dugnad-varen-2026",
    );
    assert.equal(
      buildVibboWebUrl("tema", "husordensregler", "example-coop"),
      "https://vibbo.no/example-coop/tema/husordensregler",
    );
    assert.equal(
      buildVibboWebUrl("meldinger", "sporsmal-om-leie", "example-coop"),
      "https://vibbo.no/example-coop/meldinger/sporsmal-om-leie",
    );
    assert.equal(
      buildVibboWebUrl("hendelser", "sommerfest-2026", "example-coop"),
      "https://vibbo.no/example-coop/hendelser/sommerfest-2026",
    );
  });

  it("builds general assembly, economy, HMS, and tasks URLs", () => {
    assert.equal(
      buildGeneralAssemblyWebUrl("ordinart-arsmote-2026", "12345"),
      "https://styrerommet.no/12345/generalforsamling/ordinart-arsmote-2026",
    );
    assert.equal(
      buildEconomyWebUrl("12345"),
      "https://styrerommet.no/12345/okonomi",
    );
    assert.equal(buildHmsWebUrl("12345"), "https://styrerommet.no/12345/hms");
    assert.equal(
      buildTasksWebUrl("12345"),
      "https://styrerommet.no/12345/oppgaver",
    );
  });

  it("builds Mitt Bygg web URLs for all sections", () => {
    assert.equal(
      buildMittByggWebUrl("", "12345"),
      "https://mittbygg.styrerommet.no/12345",
    );
    assert.equal(
      buildMittByggMaintenancePlanWebUrl("12345"),
      "https://mittbygg.styrerommet.no/12345/vedlikeholdsplan",
    );
    assert.equal(
      buildMittByggConditionWebUrl("12345"),
      "https://mittbygg.styrerommet.no/12345/tilstand",
    );
    assert.equal(
      buildMittByggBuildingPartWebUrl(undefined, "12345"),
      "https://mittbygg.styrerommet.no/12345/bygningsdel",
    );
    assert.equal(
      buildMittByggBuildingPartWebUrl("facade", "12345"),
      "https://mittbygg.styrerommet.no/12345/bygningsdel/facade",
    );
    assert.equal(
      buildMittByggTasksWebUrl("12345"),
      "https://mittbygg.styrerommet.no/12345/oppgaver",
    );
    assert.equal(
      buildMittByggDocumentsWebUrl("12345"),
      "https://mittbygg.styrerommet.no/12345/dokumenter",
    );
    assert.equal(
      buildMittByggCompanyWebUrl("12345"),
      "https://mittbygg.styrerommet.no/12345/om-selskapet",
    );
    assert.equal(
      buildMittByggConditionReportWebUrl("12345"),
      "https://mittbygg.styrerommet.no/12345/bygningsrapport",
    );
  });
});
