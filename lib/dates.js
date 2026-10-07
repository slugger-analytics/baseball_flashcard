/**
 * lib/dates.js — request date parsing and validation.
 */

'use strict';

const { getSeasonDefaults } = require('./config.js');

/**
 * Accepts YYYY-MM-DD, YYYYMMDD or MM-DD-YYYY; returns YYYY-MM-DD or null.
 */
function parseDateInput(dateStr) {
  if (!dateStr) return null;
  const mdyMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (mdyMatch) return `${mdyMatch[3]}-${mdyMatch[1]}-${mdyMatch[2]}`;
  if (dateStr.includes('-')) return dateStr;
  if (dateStr.length === 8) {
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  }
  return null;
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
  const finalStartDate = parseDateInput(startDate) || seasonDefaults.start;
  const finalEndDate = parseDateInput(endDate) || seasonDefaults.end;

  if (new Date(`${finalStartDate}T00:00:00Z`) > new Date(`${finalEndDate}T00:00:00Z`)) {
    return { error: 'invalid_range', status: 400, message: 'Start date must be on or before end date.' };
  }
  if (new Date(`${finalEndDate}T00:00:00Z`) > today) {
    return { error: 'future_date', status: 404, message: 'No Data Available Yet For The Selected Period' };
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

module.exports = { parseDateInput, resolveDateRange, spanDays };
