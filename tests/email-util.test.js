// utils/email.js — one person, one waitlist spot.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidEmail, normalizeEmail, isDisposable } = require("../utils/email");

test("Gmail aliases collapse to one inbox", () => {
  assert.equal(normalizeEmail("Name.Surname+news@Gmail.com"), "namesurname@gmail.com");
  assert.equal(normalizeEmail("n.a.m.e@googlemail.com"), "name@gmail.com");
  assert.equal(normalizeEmail(" a+b@outlook.com "), "a@outlook.com");
  assert.equal(normalizeEmail("first.last@company.com"), "first.last@company.com", "dots are only ignored at Gmail");
});

test("throwaway inboxes are recognised, real ones aren't", () => {
  assert.equal(isDisposable("x@mailinator.com"), true);
  assert.equal(isDisposable("x@sub.yopmail.com"), true);
  assert.equal(isDisposable("x@gmail.com"), false);
  assert.equal(isDisposable("x@notmailinator.com"), false);
});

test("basic email validation", () => {
  assert.equal(isValidEmail("ok@example.co.in"), true);
  assert.equal(isValidEmail("bad@"), false);
  assert.equal(isValidEmail("no spaces@x.com"), false);
  assert.equal(isValidEmail(""), false);
});
