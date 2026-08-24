/**
 * The parts of the business, used in two places.
 *
 * A person has one (it appears on their account and in the usage figures) and
 * so does an email recipient (it says who a report is going to). They share
 * this list deliberately: two lists would drift, and then "Warehouse" on the
 * users page and "Warehouse " on the recipients page would count as two
 * different things in every report that groups on them.
 *
 * A fixed list rather than free text for the same reason — one typo becomes a
 * permanent extra row in the analytics.
 */
export const DEPARTMENTS = [
  'Production',
  'Branches',
  // An area manager covers several branches rather than one. Which branches is
  // set per account under the locations they are granted — this only says what
  // part of the business they belong to.
  'Area Managers',
  'Warehouse',
  'Operations',
  'Analytics',
  'Supply Chain',
  'Finance',
  'Marketing',
  'IT',
  'Management',
]

export const isDepartment = (value) => DEPARTMENTS.includes(value)
