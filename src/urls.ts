import { getOrgId } from "./client.ts";
import { getCantorCompanyId } from "./cantor-client.ts";
import { getVibboOrgSlug } from "./vibbo-client.ts";

/**
 * Build web URL for an invoice in Styrerommet.
 * Opens the invoice preview modal in the economy section.
 */
export function buildInvoiceWebUrl(
  invoiceId: string,
  orgId: string = getOrgId(),
): string {
  return `https://styrerommet.no/${orgId}/okonomi?referrer=shortcuts&invoice=${encodeURIComponent(invoiceId)}&organizationNumber=${orgId}`;
}

/**
 * Build web URL for a supplier in Styrerommet.
 */
export function buildSupplierWebUrl(
  supplierId: string,
  orgId: string = getOrgId(),
): string {
  return `https://styrerommet.no/${orgId}/leverandorer/leverandor/${encodeURIComponent(supplierId)}`;
}

/**
 * Build web URL for a board meeting in Styrerommet.
 */
export function buildMeetingWebUrl(
  meetingId: string,
  orgId: string = getOrgId(),
): string {
  return `https://styrerommet.no/${orgId}/styremoter/mote/${encodeURIComponent(meetingId)}`;
}

/**
 * Build web URL for an archive file or folder in Jottacloud / arkiv.styrerommet.no.
 * Converts archive paths (e.g. /resources/{orgId}/Folder/File.pdf) into clickable browser URLs.
 */
export function buildArchiveWebUrl(
  archivePath: string,
  defaultOrgId: string = getOrgId(),
): string {
  if (!archivePath) {
    return `https://arkiv.styrerommet.no/web/${defaultOrgId}/styre/filer`;
  }

  // Clean leading/trailing slashes and split
  const trimmed = archivePath.trim().replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/").filter(Boolean);

  let folderOrgId = defaultOrgId;
  let fileParts = parts;

  if (parts.length > 0 && parts[0] === "resources") {
    if (parts.length > 1) {
      folderOrgId = parts[1]!;
      fileParts = parts.slice(2);
    } else {
      fileParts = [];
    }
  }

  if (fileParts.length === 0) {
    return `https://arkiv.styrerommet.no/web/${folderOrgId}/styre/filer`;
  }

  const encodedPath = fileParts.map((p) => encodeURIComponent(p)).join("/");
  return `https://arkiv.styrerommet.no/web/${folderOrgId}/styre/filer/${encodedPath}`;
}

/**
 * Build web URL for a Cantor Web Services dynamic report widget.
 */
export function buildCantorReportWebUrl(
  widgetDataId: number | string,
  companyId: string = getCantorCompanyId(),
): string {
  return `https://cws.obos.no/dynamicreport/${widgetDataId}?fnr=${companyId}&list=off`;
}

/**
 * Build web URL for Cantor single sign-on redirect or home.
 */
export function buildCantorHomeWebUrl(
  companyId: string = getCantorCompanyId(),
): string {
  return `https://styrerommet.no/redirect/cantor?obosCompanyNumber=${companyId}`;
}

/**
 * Build web URL for Vibbo resources (nyheter, tema, meldinger, hendelser).
 */
export function buildVibboWebUrl(
  type: "nyheter" | "tema" | "meldinger" | "hendelser",
  slug: string,
  orgSlug: string = getVibboOrgSlug(),
): string {
  return `https://vibbo.no/${orgSlug}/${type}/${encodeURIComponent(slug)}`;
}

/**
 * Build web URL for general assemblies in Styrerommet.
 */
export function buildGeneralAssemblyWebUrl(
  slug?: string,
  orgId: string = getOrgId(),
): string {
  if (slug) {
    return `https://styrerommet.no/${orgId}/generalforsamling/${encodeURIComponent(slug)}`;
  }
  return `https://styrerommet.no/${orgId}/generalforsamling`;
}

/**
 * Build web URL for general economy view in Styrerommet.
 */
export function buildEconomyWebUrl(orgId: string = getOrgId()): string {
  return `https://styrerommet.no/${orgId}/okonomi`;
}

/**
 * Build web URL for the HMS module in Styrerommet.
 */
export function buildHmsWebUrl(orgId: string = getOrgId()): string {
  return `https://styrerommet.no/${orgId}/hms`;
}

/**
 * Build web URL for tasks in Styrerommet.
 */
export function buildTasksWebUrl(orgId: string = getOrgId()): string {
  return `https://styrerommet.no/${orgId}/oppgaver`;
}

/**
 * Build web URL for Mitt Bygg (https://mittbygg.styrerommet.no).
 */
export function buildMittByggWebUrl(
  path: string = "",
  orgId: string = getOrgId(),
): string {
  const cleanPath = path.replace(/^\/+/, "");
  return cleanPath
    ? `https://mittbygg.styrerommet.no/${orgId}/${cleanPath}`
    : `https://mittbygg.styrerommet.no/${orgId}`;
}

/**
 * Build web URL for Mitt Bygg Maintenance Plan (vedlikeholdsplan).
 */
export function buildMittByggMaintenancePlanWebUrl(
  orgId: string = getOrgId(),
): string {
  return buildMittByggWebUrl("vedlikeholdsplan", orgId);
}

/**
 * Build web URL for Mitt Bygg Condition view (tilstand).
 */
export function buildMittByggConditionWebUrl(
  orgId: string = getOrgId(),
): string {
  return buildMittByggWebUrl("tilstand", orgId);
}

/**
 * Build web URL for Mitt Bygg Building Parts overview or specific part.
 */
export function buildMittByggBuildingPartWebUrl(
  partType?: string,
  orgId: string = getOrgId(),
): string {
  if (partType) {
    return buildMittByggWebUrl(
      `bygningsdel/${encodeURIComponent(partType)}`,
      orgId,
    );
  }
  return buildMittByggWebUrl("bygningsdel", orgId);
}

/**
 * Build web URL for Mitt Bygg Tasks (oppgaver).
 */
export function buildMittByggTasksWebUrl(orgId: string = getOrgId()): string {
  return buildMittByggWebUrl("oppgaver", orgId);
}

/**
 * Build web URL for Mitt Bygg Documents (dokumenter).
 */
export function buildMittByggDocumentsWebUrl(
  orgId: string = getOrgId(),
): string {
  return buildMittByggWebUrl("dokumenter", orgId);
}

/**
 * Build web URL for Mitt Bygg Company / Property information (om byggene).
 */
export function buildMittByggCompanyWebUrl(orgId: string = getOrgId()): string {
  return buildMittByggWebUrl("om-selskapet", orgId);
}

/**
 * Build web URL for Mitt Bygg Condition Report (bygningsrapport).
 */
export function buildMittByggConditionReportWebUrl(
  orgId: string = getOrgId(),
): string {
  return buildMittByggWebUrl("bygningsrapport", orgId);
}
