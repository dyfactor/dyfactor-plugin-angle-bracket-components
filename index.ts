import { AbstractDynamicPlugin, DYFACTOR_GLOBAL, Telemetry } from 'dyfactor';
import * as path from 'path';
import * as fs from 'fs';
import { preprocess, AST, print } from '@glimmer/syntax';
import * as pascalCase from 'pascal-case';
import * as tRecast from 'ember-template-recast';

const isComponentHelper = `
import {getOwner} from '@ember/application';
import Helper from '@ember/component/helper';

if (!${DYFACTOR_GLOBAL}) {
  ${DYFACTOR_GLOBAL} = {};
}

export default Helper.extend({
  compute([comp, file]) {
    let owner = getOwner(this);

    if (comp.name && comp.template) {
      comp = comp.name;
    }
    let isComponent = !!owner.lookup(\`component:$\{comp}\`);

    if (isComponent) {
      if (${DYFACTOR_GLOBAL}[file]) {
        if (!${DYFACTOR_GLOBAL}[file].includes(comp)) {
          ${DYFACTOR_GLOBAL}[file].push(comp);
        }
      } else {
        ${DYFACTOR_GLOBAL}[file] = [comp];
      }
    }
    return isComponent;
  }
});
`;

function instrument(templatePath) {
  return (env) => {
    let { builders: b } = env.syntax;
    let seen = [];
    let builtinStatements = ['if', 'unless', 'with', 'let', 'component', 'each', 'link-to', 'textarea', 'outlet'];

    function isComponent(original, node: AST.BlockStatement) {
      let isComponentSexpr = b.sexpr(b.path(`-dyfactor-is-component`), [b.string(original), b.string(templatePath)]);
      let componentHelper = b.mustache(b.path('component'), [b.string(original)]);
      let mustache = b.mustache(b.path(original));
      let conseq = b.program([node]);
      let alt = b.program([node]);
      return b.block(
        b.path('if'),
        [isComponentSexpr],
        null,
        conseq,
        alt
      );
    }

    let isAttr = false;
    return {
      name: 'instrument-mustaches',
      visitor: {
        AttrNode: {
          enter() { isAttr = true; },
          exit() { isAttr = false; }
        },

        MustacheStatement(node) {
          if (builtinStatements.includes(node.path.original) || seen.includes(node)) return node;
          if (!isAttr && node.loc.source !== '(synthetic)') {
            seen.push(node);
            return isComponent(node.path.original, node);
          }

          return node;
        },

        BlockStatement(node) {
          if (builtinStatements.includes(node.path.original) || seen.includes(node)) {
            return node;
          }
          seen.push(node);
          return isComponent(node.path.original, node);
        }
      }
    }
  }
}

function shouldUpdate(data, path) {
  return data.includes(path);
}

function applyTelemetry(data) {

  return (env) => {
    let { builders: b } = env.syntax;
    function toAtArgs(pairs) {
      return pairs.map(pair => {
        return b.attr(`@${pair.key}`, b.mustache(pair.value))
      });
    }
    return {
      BlockStatement(node) {
        if (node.params.length !== 0) return node;
        if (shouldUpdate(data, node.path.original)) {
          let atArgs = toAtArgs(node.hash.pairs);
          let tagDesc = {
            name: pascalCase(node.path.original),
            selfClosing: false
          };
          let body = [b.text('\n'), ...node.program.body];
          return b.element(tagDesc, atArgs, [], body, node.program.blockParams, node.loc);
        }
        return node;
      },
      MustacheStatement(node) {
        if (node.params.length !== 0) return node;

        if (shouldUpdate(data, node.path.original)) {
          let atArgs = toAtArgs(node.hash.pairs);
          let tagDesc = {
            name: pascalCase(node.path.original),
            selfClosing: true
          };
          return b.element(tagDesc, atArgs);
        }
        return node;
      }
    }
  }
}

export default class extends AbstractDynamicPlugin {
  instrument() {
    let templates = this.inputs.filter(input => path.extname(input) === '.hbs');
    templates.forEach(template => {
      fs.writeFileSync(`./app/helpers/-dyfactor-is-component.js`, isComponentHelper);
      let content = fs.readFileSync(template, 'utf8');
      console.log(template);
      let instrumented = preprocess(content, {
        plugins: {
          ast: [instrument(template)]
        }
      });

      fs.writeFileSync(template, print(instrumented));
    });
  }
  modify(telementry: Telemetry) {
    telementry.data.forEach((datalet) => {
      Object.keys(datalet).forEach((template) => {
        let content = fs.readFileSync(template, 'utf8');
        let data = datalet[template];
        let { code } = tRecast.transform(content, applyTelemetry(data));
        fs.writeFileSync(template, code);
      });
    });
  }
}