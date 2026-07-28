"import React from 'react';
import { rewritePrompt } from '../api';

const LtxSulphurGenerator = () => {
  const [prompt, setPrompt] = React.useState('Initial prompt');
  const [rewritten, setRewritten] = React.useState('');

  const handleRewrite = async () => {
    setRewritten(await rewritePrompt(prompt));
  };

  return (
    <div>
      <button onClick={handleRewrite}>Rewrite Prompt</button>
      <p>Rewritten: {rewritten}</p>
    </div>
  );
};

export default LtxSulphurGenerator;
"