import React, { useState, useEffect } from 'react';

interface TypewriterTitleProps {
  text: string;
  icon?: React.ReactNode;
}

const TypewriterTitle: React.FC<TypewriterTitleProps> = ({ text, icon }) => {
  const [displayedText, setDisplayedText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  
  useEffect(() => {
    let timeout: NodeJS.Timeout;

    const type = () => {
      setDisplayedText((current) => {
        if (!isDeleting) {
          // Typing forward
          if (current.length < text.length) {
            timeout = setTimeout(type, 100); // Typing speed
            return text.slice(0, current.length + 1);
          } else {
            // Done typing, wait before deleting
            timeout = setTimeout(() => {
              setIsDeleting(true);
              type();
            }, 3000); // Wait 3 seconds before backspacing
            return current;
          }
        } else {
          // Backspacing
          if (current.length > 0) {
            timeout = setTimeout(type, 50); // Backspacing speed (usually faster)
            return text.slice(0, current.length - 1);
          } else {
            // Done deleting, wait before typing again
            timeout = setTimeout(() => {
              setIsDeleting(false);
              type();
            }, 1000); // Wait 1 second before typing again
            return current;
          }
        }
      });
    };

    timeout = setTimeout(type, 500); // Initial delay

    return () => clearTimeout(timeout);
  }, [text, isDeleting]);

  return (
    <h2 className="panel-title pixel-font">
      {icon}
      <span>{displayedText}</span>
      <span className="cursor blink">_</span>
    </h2>
  );
};

export default TypewriterTitle;
