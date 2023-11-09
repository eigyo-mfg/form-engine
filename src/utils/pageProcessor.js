const {handleAgreement, takeScreenshot, getLongestElementHtml} = require('./puppeteer');
const {
  INPUT_RESULT_FORM_NOT_FOUND,
  INPUT_RESULT_ERROR,
  INPUT_RESULT_NONE,
  RESULT_SUCCESS,
  RESULT_ERROR,
} = require('./result');
const {
  formatAndLogFormData, getFieldsAndSubmit, stripAttributes,
} = require('./formParser');
const {fetchInputData} = require('../services/spreadsheet');
const {
  createMappingPrompt,
  requestAndAnalyzeMapping,
} = require('../services/openai');
const {fillFormFields, submitForm} = require('./formSubmitter');
const {
  STATE_INPUT,
  STATE_DONE,
  STATE_CONFIRM,
  STATE_COMPLETE,
  STATE_ERROR, currentState,
} = require('./state');
const {generateFormsDocumentId} = require("../services/firestore");
const MAX_ERROR = 0;
const MAX_INPUT_TRIALS = 2;
const MAX_TRIALS = 3;

/**
 * ページの処理を行うクラス
 * @property {object} page
 * @property {string} url
 * @property {string} formId
 * @property {string} state
 * @property {number} errorCount
 * @property {number} inputTrials
 * @property {object} inputData
 * @property {boolean} existConfirm
 * @property {array} fields
 * @property {string} submit
 * @property {string} inputResult
 * @property {object} formMapping
 * @property {string} mappingPrompt
 *
 */
class PageProcessor {
  /**
   * コンストラクタ
   * @param {Page} page
   * @param {string} url
   */
  constructor(page, url) {
    this.page = page;
    this.url = url;
    this.formId = generateFormsDocumentId(url);
    this.state = STATE_INPUT;
    this.errorCount = 0;
    this.inputTrials = 0;
    this.inputData = null;
    this.existConfirm = false;
    this.fields = [];
    this.submit = '';
    this.inputResult = INPUT_RESULT_NONE;
    this.formMapping = null;
    this.mappingPrompt = '';
  }

  /**
   * ページの処理
   * @return {Promise<void>}
   */
  async pageProcess() {
    while (this.state !== STATE_DONE && this.errorCount <= MAX_ERROR) {
      try {
        const processState = this.state;
        switch (processState) {
          case STATE_INPUT:
            await this.#processOnInput();
            break;
          case STATE_CONFIRM:
            await this.#processOnConfirm();
            break;
          case STATE_COMPLETE:
            await this.#processOnComplete();
            continue;
          case STATE_ERROR:
            await this.#processOnError();
            continue;
          default:
            throw new Error(`Unknown state: ${this.state}`);
        }
        // 状態判定
        this.state = await currentState(this.page, this.fields, this.formId);
        if (this.state === processState) {
          throw new Error('State not changed. state=' + this.state);
        }
      } catch (e) {
        console.error(e);
        this.state = STATE_ERROR;
        this.errorCount++;
        // throw new Error(e.message) // TODO
      }
    }
  }

  /**
   * 入力ページの処理
   * @return {Promise<void>}
   */
  async #processOnInput() {
    // Input state processing logic
    console.log('input process');
    this.inputTrials++;
    if (this.inputTrials > MAX_INPUT_TRIALS) {
      console.log('Max processOnInput trials reached, skipping...');
      this.state = STATE_ERROR;
      return;
    }

    // 同意画面の処理
    await handleAgreement(this.page);
    // フォームのHTMLを返す
    // const longestFormHTML = await extractFormHTML(this.page);
    const formHTML = await getLongestElementHtml(this.page, "form");
    if (formHTML === undefined || formHTML.length === 0) {
      console.log('No form found in the HTML. Exiting processOnInput...');
      this.inputResult = INPUT_RESULT_FORM_NOT_FOUND;
      return;
    }
    // const {fields, submit} = analyzeFields(longestFormHTML);
    const {fields, submit} = getFieldsAndSubmit(formHTML)
    this.fields = fields;
    this.submit = submit;
    console.log('Fields:', fields, 'Submit:', submit);

    const formattedFormHTML = stripAttributes(formHTML);
    console.log('Formatted form HTML:', formattedFormHTML);

    // 入力用データ取得
    const inputData = await fetchInputData();
    this.inputData = inputData;

    // 入力データとフォームのマッピング用プロンプトを作成
    const mappingPrompt = createMappingPrompt(fields, inputData, formattedFormHTML);
    this.mappingPrompt = mappingPrompt;

    // ChatGPTによるマッピング結果取得
    const formMappingGPTResult = await requestAndAnalyzeMapping(mappingPrompt, this.formId);
    this.formMapping = formMappingGPTResult;

    // フォーム入力用データをフォーマット
    formatAndLogFormData(formMappingGPTResult, inputData);
    // フォームに入力
    await fillFormFields(this.page, formMappingGPTResult, inputData);
    // フォームを送信
    await submitForm(this.page, this.submit)
        .then((result) => {
          console.log('Submit result:', result);
          this.inputResult = result;
        })
        .catch((error) => {
          console.error('Submit error:', error);
          this.inputResult = INPUT_RESULT_ERROR;
        });
  }

  /**
   * 確認ページの処理
   * @return {Promise<void>}
   */
  async #processOnConfirm() {
    // Confirm state processing logic
    console.log('confirm process');
    this.existConfirm = true;

    try {
      await this.page.waitForSelector(
          'input[type="submit"], button[type="submit"]',
          {timeout: 10000},
      );
      console.log('Wait for selectors completed');

      const currentURL = this.page.url();
      console.log(`Current URL before clicking: ${currentURL}`);

      const buttons = await this.page.$$('button, input[type="submit"]');
      console.log(`Found ${buttons.length} buttons`);

      for (const button of buttons) {
        const buttonText = await this.page.evaluate(
            (el) => el.textContent || el.value,
            button,
        );
        const onClickAttribute = await this.page.evaluate(
            (el) => el.getAttribute('onclick'),
            button,
        );
        const isDisabled = await this.page
            .evaluate((el) => el.disabled, button);
        console.log(
            'Button Text:', buttonText,
            'OnClick Attribute:', onClickAttribute,
            'Is button disabled?', isDisabled,
        );

        if (
          buttonText.includes('送') ||
          buttonText.includes('内容') ||
          buttonText.includes('確認')
        ) {
          console.log('Matching button found. Taking screenshot...');
          await takeScreenshot(this.page, 'confirm');

          const navigationPromise = this.page.waitForNavigation({
            timeout: 10000,
          });

          if (onClickAttribute) {
            console.log('Executing JavaScript click event');
            await this.page.evaluate((el) => el.click(), button); // ボタン要素をクリック
          } else {
            console.log('Performing normal click');
            await button.click();
          }

          await navigationPromise;
          console.log('Navigation completed');
          break;
        }
      }
    } catch (error) {
      console.log(`An error occurred: ${error.message}`);
      // ここでエラーハンドリングの処理を追加することができます（例：リトライ、ログを送信する等）
    }

    console.log('Ending processOnConfirm function');
  }

  /**
   * 完了ページの処理
   * @return {Promise<void>}
   */
  async #processOnComplete() {
    // Complete state processing logic
    console.log('complete process');
    // スクリーンショットを撮る
    await takeScreenshot(this.page, 'complete');
    this.state = STATE_DONE;
  }

  /**
   * エラー時の処理
   * @return {Promise<void>}
   */
  async #processOnError() {
    // Error state processing logic
    console.log('error process');
    await takeScreenshot(this.page, 'error');
    this.state = STATE_INPUT;
    this.errorCount++;
  }

  /**
   * 結果を返す
   * @return {{
   *  existConfirm: boolean,
   *  result: (string),
   *  reason: null,
   *  inputData: null,
   *  inputResult: string,
   *  submit: string,
   *  inputTrialCount: number,
   *  state: string,
   *  fields: null,
   *  formMapping: null
   *  mappingPrompt: string,
   * }}
   */
  getResults() {
    return {
      existConfirm: this.existConfirm,
      reason: this.inputResult,
      state: this.state,
      result: this.state === STATE_DONE ? RESULT_SUCCESS : RESULT_ERROR,
      inputTrialCount: this.inputTrials,
      inputData: this.inputData,
      inputResult: this.inputResult,
      formMapping: this.formMapping,
      mappingPrompt: this.mappingPrompt,
      fields: this.fields,
      submit: this.submit,
    };
  }
}

module.exports = {
  PageProcessor,
};