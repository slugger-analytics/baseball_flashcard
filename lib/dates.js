/**
 * lib/dates.js — request date parsing and validation.
 */

'use strict';

const { getSeasonDefaults } = require('./config.js');

const MAX_DATE_RANGE_DAYS = 370;

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Accepts YYYY-MM-DD, YYYYMMDD or MM-DD-YYYY; returns YYYY-MM-DD or null.
 */
function parseDateInput(dateStr) {
  if (typeof dateStr !== 'string' || !dateStr) return null;
  const mdyMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const normalized = mdyMatch
    ? `${mdyMatch[3]}-${mdyMatch[1]}-${mdyMatch[2]}`
    : /^\d{8}$/.test(dateStr)
      ? `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`
      : dateStr;
  return isCalendarDate(normalized) ? normalized : null;
}

/**
 * Normalizes and validates a requested date range, falling back to season defaults.
 * @param {string} startDate - Raw start date (YYYY-MM-DD, YYYYMMDD, or MM-DD-YYYY).
 * @param {string} endDate - Raw end date.
 * @returns {{finalStartDate:string, finalEndDate:string} | {error:string, status:number, message:string}}
 */
function resolveDateRange(startDate, endDate) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const seasonDefaults = getSeasonDefaults();
  const parsedStartDate = parseDateInput(startDate);
  const parsedEndDate = parseDateInput(endDate);
  if ((startDate != null && !parsedStartDate) || (endDate != null && !parsedEndDate)) {
    return { error: 'invalid_date', status: 400, message: 'Dates must be valid calendar dates.' };
  }
  const finalStartDate = startDate == null ? seasonDefaults.start : parsedStartDate;
  const finalEndDate = endDate == null ? seasonDefaults.end : parsedEndDate;

  const days = spanDays(finalStartDate, finalEndDate) + 1;
  if (days <= 0) {
    return { error: 'invalid_range', status: 400, message: 'Start date must be on or before end date.' };
  }
  if (new Date(`${finalEndDate}T00:00:00Z`) > today) {
    return { error: 'future_date', status: 404, message: 'No Data Available Yet For The Selected Period' };
  }
  if (days > MAX_DATE_RANGE_DAYS) {
    return { error: 'range_too_large', status: 400, message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days.` };
  }
  return { finalStartDate, finalEndDate };
}

/**
 * Whole days from start to end (0 for unparseable input).
 */
function spanDays(start, end) {
  const d = (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000;
  return Number.isFinite(d) ? d : 0;
}

module.exports = { parseDateInput, resolveDateRange, spanDays, MAX_DATE_RANGE_DAYS };
