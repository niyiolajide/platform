'use client';
import fs from 'node:fs';

const token = process.env.SECRET_TOKEN;
export function load() {
  return [fs, token];
}
