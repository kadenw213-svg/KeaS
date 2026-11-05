// The most common leaked passwords that are 10+ characters (shorter ones are already refused by length).
// A starter list; a larger bundled list (top 100k) replaces it before public release.
export const COMMON = new Set([
  '1234567890', '12345678910', '123456789a', '0123456789', '0987654321', '1111111111', '1234512345', '1q2w3e4r5t',
  '1qaz2wsx3edc', 'qwertyuiop', 'qwerty12345', 'qwerty123456', 'password12', 'password123', 'password1234', 'password!',
  'passw0rd123', 'iloveyou12', 'iloveyou123', 'princess12', 'football12', 'football123', 'baseball12', 'basketball',
  'basketball1', 'superman12', 'starwars12', 'charlie123', 'michael123', 'jordan2323', 'abcdefghij', 'abc1234567',
  'abcd123456', 'a123456789', 'asdfghjkl1', 'asdfghjkl;', 'zxcvbnm123', 'qazwsxedc1', 'qazwsxedcrfv', 'letmein123',
  'welcome123', 'welcome1234', 'monkey1234', 'dragon1234', 'sunshine12', 'whatever12', 'trustno1234', 'computer12',
  'internet12', 'chocolate1', 'chocolate12', 'butterfly1', 'pokemon123', 'minecraft1', 'minecraft12', 'fortnite123',
  'liverpool1', 'manchester', 'blink18218', 'myspace123', 'linkedin123', 'facebook123', 'qwertyuiop1', 'admin12345',
  'administrator', 'changeme123', 'default123', 'p@ssw0rd123', 'p@ssword123', 'passwordpassword', 'mypassword',
  'mypassword1', 'secret1234', 'loveyou123', 'samsung123', 'nintendo123', 'spiderman1', 'batman1234', '9876543210',
  '1122334455', '1212121212', '1231231231', '0000000000', '5555555555', '7777777777', '6969696969', '1234554321',
  'aaaaaaaaaa', 'qwertyqwerty', 'asdfasdfasdf', 'kea12345678', 'keapassword',
]);
