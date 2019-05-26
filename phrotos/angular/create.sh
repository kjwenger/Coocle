#!/usr/bin/env bash

npm --version
node --version
nvm install 8
nvm use 8
npm install -g @angular/cli
ng new CooclePhrotos
npm install --save @angular/material @angular/cdk @angular/animations